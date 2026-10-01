package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
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
