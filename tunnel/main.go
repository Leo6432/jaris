// jaris-tunnel : le pont entre le téléphone de l'utilisateur et Jaris, sans aucune appli à installer à côté.
//
// Embarque Tailscale (tsnet) et publie, par Tailscale Funnel, une adresse HTTPS
// (https://jaris.<réseau>.ts.net) dont le chiffrement se termine ICI, sur le PC : le relais de Tailscale ne
// fait que transporter des octets chiffrés (voir https://tailscale.com/kb/1223/funnel). Chaque requête est
// ensuite transmise telle quelle au petit serveur de Jaris, qui n'écoute que sur 127.0.0.1 et qui, lui,
// vérifie l'appairage du téléphone (voir electron/services/phoneServer.ts).
//
// Lancé par Electron (phoneTunnel.ts), jamais à la main. Une ligne JSON par événement sur stdout :
//
//	{"event":"starting"}
//	{"event":"login","url":"https://login.tailscale.com/a/..."}  connexion Tailscale à faire dans le navigateur
//	{"event":"enable_funnel","url":"...","text":"..."}           autoriser l'adresse web publique, une fois
//	{"event":"ready","url":"https://jaris.xxx.ts.net"}
//	{"event":"error","message":"..."}
//	{"event":"logged_out"}                                       (avec --logout)
//
// stdin fermé (Jaris quitté, même brutalement) = arrêt : le tunnel ne survit jamais à Jaris.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"tailscale.com/client/local"
	"tailscale.com/envknob"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/logtail"
	"tailscale.com/tailcfg"
	"tailscale.com/tsnet"
)

var emitMu sync.Mutex

func emit(payload map[string]string) {
	emitMu.Lock()
	defer emitMu.Unlock()
	line, _ := json.Marshal(payload)
	os.Stdout.Write(append(line, '\n'))
}

// stopOrFail : une attente interrompue parce que Jaris a fermé le tunnel n'est pas une erreur à signaler.
func stopOrFail(ctx context.Context, err error) {
	if ctx.Err() != nil {
		os.Exit(0)
	}
	fail(err)
}

func fail(err error) {
	emit(map[string]string{"event": "error", "message": err.Error()})
	os.Exit(1)
}

// newProxy transmet chaque requête au serveur local de Jaris. FlushInterval -1 : les réponses partent dès
// qu'elles sont écrites, sans tampon. Les en-têtes X-Forwarded-* venus d'internet sont retirés : rien de ce
// qu'envoie un inconnu ne doit pouvoir se faire passer pour une information du tunnel.
func newProxy(target *url.URL) http.Handler {
	proxy := &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(target)
			r.Out.Host = target.Host
			r.Out.Header.Del("X-Forwarded-For")
			r.Out.Header.Del("X-Forwarded-Host")
			r.Out.Header.Del("X-Forwarded-Proto")
			r.Out.Header.Set("X-Jaris-Tunnel", "1")
		},
		FlushInterval: -1,
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) {
			http.Error(w, "Jaris ne répond pas sur le PC.", http.StatusBadGateway)
		},
	}
	return proxy
}

// newHTTPServer : délais bornés pour qu'une connexion lente ou abandonnée ne reste jamais ouverte
// indéfiniment ; 2 minutes d'écriture couvrent un message vocal envoyé depuis une connexion 4G modeste.
func newHTTPServer(handler http.Handler) *http.Server {
	return &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 15 * time.Second,
		ReadTimeout:       2 * time.Minute,
		WriteTimeout:      2 * time.Minute,
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    32 << 10,
	}
}

// waitUntilRunning attend que le nœud soit connecté au réseau Tailscale, en signalant l'adresse de connexion
// à ouvrir dans le navigateur tant qu'il ne l'est pas (une seule fois par adresse).
func waitUntilRunning(ctx context.Context, lc *local.Client) (*ipnstate.Status, error) {
	lastURL := ""
	for {
		st, err := lc.StatusWithoutPeers(ctx)
		if err == nil {
			if st.BackendState == "Running" && st.Self != nil {
				return st, nil
			}
			if st.AuthURL != "" && st.AuthURL != lastURL {
				lastURL = st.AuthURL
				emit(map[string]string{"event": "login", "url": st.AuthURL})
			}
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(time.Second):
		}
	}
}

func hasFunnelCaps(st *ipnstate.Status) bool {
	return st.Self != nil && st.Self.HasCap(tailcfg.CapabilityHTTPS) && st.Self.HasCap(tailcfg.NodeAttrFunnel) && len(st.CertDomains) > 0
}

// waitForFunnel : Funnel (et HTTPS) doivent être autorisés une fois sur le compte Tailscale. Tailscale
// fournit lui-même l'adresse de la page où cliquer ; on la transmet, puis on attend que ce soit fait.
func waitForFunnel(ctx context.Context, lc *local.Client) (*ipnstate.Status, error) {
	announced := false
	for {
		st, err := lc.StatusWithoutPeers(ctx)
		if err == nil && hasFunnelCaps(st) {
			return st, nil
		}
		if !announced {
			info, qerr := lc.QueryFeature(ctx, "funnel")
			if qerr == nil && info != nil && !info.Complete {
				announced = true
				emit(map[string]string{"event": "enable_funnel", "url": info.URL, "text": info.Text})
			}
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
}

// stateDirFor : sous Windows, Tailscale réécrit le propriétaire et les droits de tout dossier d'état nommé
// exactement « tailscale » (paths.ensureStateDirPermsWindows), ce qu'un programme lancé SANS droits
// d'administrateur n'a pas le droit de faire : « creating state directory: Access is denied » (vécu par Léo en
// v0.22.0, dont le dossier s'appelait justement « tailscale »). Ce nom est donc toujours évité.
func stateDirFor(dir string) string {
	if strings.EqualFold(filepath.Base(filepath.Clean(dir)), "tailscale") {
		return filepath.Join(dir, "jaris")
	}
	return dir
}

func main() {
	stateDir := flag.String("state", "", "dossier où Tailscale garde l'identité de ce PC")
	target := flag.String("target", "", "adresse du serveur local de Jaris (127.0.0.1:port)")
	hostname := flag.String("hostname", "jaris", "nom de ce PC dans le réseau Tailscale")
	logout := flag.Bool("logout", false, "déconnecte ce PC de Tailscale puis quitte")
	flag.Parse()
	if *stateDir == "" {
		fail(errors.New("--state manquant"))
	}

	// Confidentialité : tsnet envoie par défaut ses journaux techniques aux serveurs de Tailscale. Coupé ici,
	// avec l'option officielle prévue pour ça, avant tout démarrage.
	envknob.SetNoLogsNoSupport()
	logtail.Disable()

	srv := &tsnet.Server{
		Dir:      stateDirFor(*stateDir),
		Hostname: *hostname,
		Logf:     func(string, ...any) {},
		// Messages destinés à un humain devant un terminal (« restart with TS_AUTHKEY… », répétés toutes les
		// 5 s) : l'adresse de connexion est déjà transmise par l'événement "login", rien d'autre à en tirer.
		UserLogf: func(string, ...any) {},
	}
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// Jaris fermé (même brutalement) = stdin fermé = le tunnel s'arrête.
	go func() {
		_, _ = io.Copy(io.Discard, bufio.NewReader(os.Stdin))
		cancel()
		srv.Close()
		os.Exit(0)
	}()

	emit(map[string]string{"event": "starting"})
	if err := srv.Start(); err != nil {
		fail(fmt.Errorf("démarrage de Tailscale impossible : %w", err))
	}
	lc, err := srv.LocalClient()
	if err != nil {
		fail(err)
	}

	if *logout {
		if err := lc.Logout(ctx); err != nil {
			fail(fmt.Errorf("déconnexion de Tailscale impossible : %w", err))
		}
		emit(map[string]string{"event": "logged_out"})
		return
	}

	if *target == "" {
		fail(errors.New("--target manquant"))
	}
	targetURL, err := url.Parse("http://" + *target)
	if err != nil || targetURL.Hostname() != "127.0.0.1" {
		fail(errors.New("--target doit être une adresse 127.0.0.1:port"))
	}

	if _, err := waitUntilRunning(ctx, lc); err != nil {
		stopOrFail(ctx, err)
	}
	st, err := waitForFunnel(ctx, lc)
	if err != nil {
		stopOrFail(ctx, err)
	}

	ln, err := srv.ListenFunnel("tcp", ":443")
	if err != nil {
		fail(fmt.Errorf("adresse web publique impossible à ouvrir : %w", err))
	}
	emit(map[string]string{"event": "ready", "url": "https://" + st.CertDomains[0]})

	if err := newHTTPServer(newProxy(targetURL)).Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) && !errors.Is(err, net.ErrClosed) {
		fail(err)
	}
}
