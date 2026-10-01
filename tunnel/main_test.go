package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"errors"
	"io"
	"os"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
)

// Le relais transmet la requête telle quelle au serveur local de Jaris, mais jamais les en-têtes
// X-Forwarded-* venus d'internet : un inconnu ne doit pas pouvoir se faire passer pour le tunnel.
func TestProxyForwardsAndStripsForwardedHeaders(t *testing.T) {
	var got *http.Request
	var body string
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r
		b, _ := io.ReadAll(r.Body)
		body = string(b)
		w.Write([]byte("ok"))
	}))
	defer backend.Close()
	target, _ := url.Parse(backend.URL)

	front := httptest.NewServer(newProxy(target))
	defer front.Close()

	req, _ := http.NewRequest("POST", front.URL+"/api/message?x=1", strings.NewReader(`{"text":"salut"}`))
	req.Header.Set("Authorization", "Bearer abc")
	req.Header.Set("X-Forwarded-For", "6.6.6.6")
	req.Header.Set("X-Jaris-Tunnel", "0")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()

	if got == nil || got.URL.Path != "/api/message" || got.URL.RawQuery != "x=1" {
		t.Fatalf("requête mal transmise : %+v", got)
	}
	if body != `{"text":"salut"}` {
		t.Fatalf("corps modifié : %q", body)
	}
	if got.Header.Get("Authorization") != "Bearer abc" {
		t.Fatal("le jeton du téléphone doit arriver jusqu'à Jaris")
	}
	if xff := got.Header.Get("X-Forwarded-For"); strings.Contains(xff, "6.6.6.6") {
		t.Fatalf("X-Forwarded-For venu d'internet transmis : %q", xff)
	}
	if got.Header.Get("X-Jaris-Tunnel") != "1" {
		t.Fatal("le marqueur du tunnel doit être posé par le tunnel, jamais repris du client")
	}
}

// Jaris arrêté côté PC : réponse lisible, pas une page d'erreur technique.
func TestProxyBackendDown(t *testing.T) {
	target, _ := url.Parse("http://127.0.0.1:1")
	front := httptest.NewServer(newProxy(target))
	defer front.Close()
	res, err := http.Get(front.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusBadGateway || !strings.Contains(string(b), "Jaris ne répond pas") {
		t.Fatalf("réponse inattendue : %d %q", res.StatusCode, b)
	}
}

// Un dossier d'état nommé « tailscale » déclenche, sous Windows, une réécriture des droits refusée sans
// administrateur (« Access is denied », v0.22.0) : il n'est jamais utilisé tel quel.
func TestStateDirNeverNamedTailscale(t *testing.T) {
	for _, dir := range []string{"/data/tailscale", "/data/Tailscale", "/data/TAILSCALE/"} {
		if got := stateDirFor(dir); strings.EqualFold(filepath.Base(got), "tailscale") {
			t.Fatalf("%q -> %q : encore nommé tailscale", dir, got)
		}
	}
	if got := stateDirFor("/data/phone-tunnel"); got != "/data/phone-tunnel" {
		t.Fatalf("un autre nom doit rester tel quel, obtenu %q", got)
	}
}

// Une erreur de certificat est transmise à Jaris (au lieu d'une simple page d'erreur sur le téléphone), mais
// sans inonder : au plus une fois toutes les 30 secondes.
func TestReportingCertificatesEmitsOnceAndPassesErrorThrough(t *testing.T) {
	calls := 0
	get := reportingCertificates(func(*tls.ClientHelloInfo) (*tls.Certificate, error) {
		calls++
		return nil, errors.New("acme: rate limited")
	})
	var out bytes.Buffer
	restore := captureStdout(&out)
	for i := 0; i < 3; i++ {
		if _, err := get(&tls.ClientHelloInfo{ServerName: "jaris.example.ts.net"}); err == nil {
			t.Fatal("l'erreur doit rester une erreur pour la connexion")
		}
	}
	restore()
	if calls != 3 {
		t.Fatalf("chaque connexion doit demander le certificat : %d", calls)
	}
	if n := strings.Count(out.String(), `"tls_error"`); n != 1 {
		t.Fatalf("une seule alerte attendue, obtenu %d : %s", n, out.String())
	}
	if !strings.Contains(out.String(), "acme: rate limited") {
		t.Fatalf("le vrai message doit être transmis : %s", out.String())
	}
}

// La vérification de l'adresse ne se contente pas d'une connexion : il faut une vraie réponse de Jaris.
func TestCheckPublicAddressNeedsRealAnswer(t *testing.T) {
	ok := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/manifest.webmanifest" {
			w.Write([]byte("{}"))
			return
		}
		http.NotFound(w, r)
	}))
	defer ok.Close()
	if err := checkPublicAddress(context.Background(), ok.URL); err != nil {
		t.Fatalf("adresse qui répond : %v", err)
	}
	down := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "Jaris ne répond pas sur le PC.", http.StatusBadGateway)
	}))
	defer down.Close()
	if err := checkPublicAddress(context.Background(), down.URL); err == nil {
		t.Fatal("une réponse 502 n'est pas une adresse qui marche")
	}
}

// captureStdout redirige les événements émis (stdout) vers buf le temps d'un test.
func captureStdout(buf *bytes.Buffer) func() {
	r, w, _ := os.Pipe()
	old := os.Stdout
	os.Stdout = w
	done := make(chan struct{})
	go func() {
		io.Copy(buf, r)
		close(done)
	}()
	return func() {
		w.Close()
		<-done
		os.Stdout = old
	}
}
