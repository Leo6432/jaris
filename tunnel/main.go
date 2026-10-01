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
//	{"event":"preparing","text":"..."}                          certificat, puis vérification depuis internet
//	{"event":"ready","url":"https://jaris.xxx.ts.net"}           (+ "warning" si l'adresse ne répond pas encore)
//	{"event":"tls_error","message":"..."}                        une connexion sécurisée a échoué
//	{"event":"error","message":"..."}
//	{"event":"logged_out"}                                       (avec --logout)
//
// stdin fermé (Jaris quitté, même brutalement) = arrêt : le tunnel ne survit jamais à Jaris.
package main

import (
	"bufio"
	"context"
	"crypto/tls"
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

// prefetchCertificate : la première fois, Tailscale doit obtenir un certificat HTTPS (Let's Encrypt) pour
// l'adresse, ce qui peut prendre une minute. Si un téléphone arrive pendant ce temps, la connexion sécurisée
// échoue (ERR_SSL_PROTOCOL_ERROR, vécu par Léo en v0.22.1). On l'obtient donc AVANT d'annoncer l'adresse.
func prefetchCertificate(ctx context.Context, lc *local.Client, domain string) error {
	ctx, cancel := context.WithTimeout(ctx, 4*time.Minute)
	defer cancel()
	_, _, err := lc.CertPair(ctx, domain)
	return err
}

// checkPublicAddress fait depuis le PC exactement ce que fera le téléphone : une vraie requête HTTPS vers
// l'adresse publique, par internet et le relais Funnel. Seul ce test prouve que l'adresse marche.
func checkPublicAddress(ctx context.Context, address string) error {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, address+"/manifest.webmanifest", nil)
	if err != nil {
		return err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("réponse inattendue (%d)", res.StatusCode)
	}
	return nil
}

// reportingCertificates transmet à Jaris toute erreur de connexion sécurisée (au plus une fois toutes les 30 s),
// au lieu de la laisser invisible : sans elle, Léo ne voyait qu'une page d'erreur sur son téléphone.
func reportingCertificates(get func(*tls.ClientHelloInfo) (*tls.Certificate, error)) func(*tls.ClientHelloInfo) (*tls.Certificate, error) {
	var mu sync.Mutex
	var last time.Time
	return func(hi *tls.ClientHelloInfo) (*tls.Certificate, error) {
		cert, err := get(hi)
		if err != nil {
			mu.Lock()
			if time.Since(last) > 30*time.Second {
				last = time.Now()
				emit(map[string]string{"event": "tls_error", "message": err.Error()})
			}
			mu.Unlock()
		}
		return cert, err
	}
}

// openLogFile : journal technique de Tailscale, gardé SUR LE PC uniquement (jamais envoyé), pour comprendre un
// échec. Repart à zéro au-delà de 2 Mo.
func openLogFile(dir string) func(string, ...any) {
	path := filepath.Join(dir, "jaris-tunnel.log")
	if fi, err := os.Stat(path); err == nil && fi.Size() > 2<<20 {
		_ = os.Remove(path)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return func(string, ...any) {}
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return func(string, ...any) {}
	}
	var mu sync.Mutex
	return func(format string, args ...any) {
		mu.Lock()
		defer mu.Unlock()
		fmt.Fprintf(f, "%s "+format+"\n", append([]any{time.Now().Format(time.RFC3339)}, args...)...)
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

	dir := stateDirFor(*stateDir)
	logf := openLogFile(dir)
	srv := &tsnet.Server{
		Dir:      dir,
		Hostname: *hostname,
		Logf:     logf,
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

	domain := st.CertDomains[0]
	address := "https://" + domain

	emit(map[string]string{"event": "preparing", "text": "Préparation du certificat sécurisé (jusqu'à 2 minutes la première fois)…"})
	if err := prefetchCertificate(ctx, lc, domain); err != nil {
		stopOrFail(ctx, fmt.Errorf("certificat HTTPS impossible à obtenir : %w", err))
	}

	ln, err := srv.ListenFunnel("tcp", ":443", tsnet.FunnelTLSConfig(&tls.Config{
		GetCertificate: reportingCertificates(lc.GetCertificate),
		NextProtos:     []string{"h2", "http/1.1"},
	}))
	if err != nil {
		fail(fmt.Errorf("adresse web publique impossible à ouvrir : %w", err))
	}
	served := make(chan error, 1)
	go func() { served <- newHTTPServer(newProxy(targetURL)).Serve(ln) }()

	// La toute première fois, l'adresse peut mettre plusieurs minutes à exister sur internet (DNS). On ne la
	// donne au téléphone qu'une fois qu'elle répond vraiment ; au-delà de 10 minutes, on la donne quand même,
	// avec la dernière erreur, pour ne jamais bloquer une adresse qui marcherait depuis un autre réseau.
	emit(map[string]string{"event": "preparing", "text": "Vérification de l'adresse depuis internet (jusqu'à 10 minutes la première fois)…"})
	deadline := time.Now().Add(10 * time.Minute)
	for {
		checkErr := checkPublicAddress(ctx, address)
		if checkErr == nil {
			emit(map[string]string{"event": "ready", "url": address})
			break
		}
		logf("vérification de %s : %v", address, checkErr)
		if time.Now().After(deadline) {
			emit(map[string]string{"event": "ready", "url": address, "warning": "L'adresse ne répond pas encore depuis internet : " + checkErr.Error()})
			break
		}
		select {
		case <-ctx.Done():
			os.Exit(0)
		case err := <-served:
			fail(err)
		case <-time.After(10 * time.Second):
		}
	}

	if err := <-served; err != nil && !errors.Is(err, http.ErrServerClosed) && !errors.Is(err, net.ErrClosed) {
		fail(err)
	}
}
