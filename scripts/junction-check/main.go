// Étape 289 : vérifie, sur un VRAI Windows (la CI), la cause des modèles « introuvables » de Léo après la mise à
// jour d'Ollama. Ollama 0.40+ passe chaque modèle par filepath.EvalSymlinks avant de le lire
// (manifest.openVerifiedManifestLocked, resolveManifestPath) ; ce programme refait exactement cet appel, à travers une
// jonction comme celle que Jaris pose sur %USERPROFILE%\.ollama\models, puis par le vrai chemin du même dossier.
//
// Échoue si le constat ne tient plus (une version de Go qui traverse de nouveau les jonctions) : le contournement de
// Jaris (donner à Ollama le vrai chemin, ollamaModelsVariable.ts) serait alors à réévaluer.
package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

func fail(format string, args ...any) {
	fmt.Printf("ÉCHEC : "+format+"\n", args...)
	os.Exit(1)
}

func main() {
	if runtime.GOOS != "windows" {
		fmt.Println("Windows seulement : rien à vérifier ici.")
		return
	}
	base, err := os.MkdirTemp("", "jaris-junction")
	if err != nil {
		fail("dossier temporaire : %v", err)
	}
	defer os.RemoveAll(base)

	real := filepath.Join(base, "jaris", "ollama-models")
	manifest := filepath.Join("manifests-v2", "ollama.com", "library", "qwen3.8", "27b")
	if err := os.MkdirAll(filepath.Dir(filepath.Join(real, manifest)), 0o755); err != nil {
		fail("dossier des modèles : %v", err)
	}
	if err := os.WriteFile(filepath.Join(real, manifest), []byte("{}"), 0o644); err != nil {
		fail("manifeste : %v", err)
	}
	link := filepath.Join(base, ".ollama", "models")
	if err := os.MkdirAll(filepath.Dir(link), 0o755); err != nil {
		fail("dossier .ollama : %v", err)
	}
	if out, err := exec.Command("cmd", "/c", "mklink", "/J", link, real).CombinedOutput(); err != nil {
		fail("mklink /J : %v %s", err, out)
	}

	// Windows lui-même suit la jonction : écrire et lire le fichier marche (d'où le téléchargement « réussi »).
	if _, err := os.ReadFile(filepath.Join(link, manifest)); err != nil {
		fail("lecture directe à travers la jonction : %v", err)
	}
	_, viaReal := filepath.EvalSymlinks(filepath.Join(real, manifest))
	_, viaLink := filepath.EvalSymlinks(filepath.Join(link, manifest))
	fmt.Printf("Go %s — EvalSymlinks par le vrai chemin : %v ; à travers la jonction : %v (introuvable pour Ollama : %v)\n",
		runtime.Version(), viaReal, viaLink, os.IsNotExist(viaLink))
	if viaReal != nil {
		fail("le vrai chemin devrait se lire : %v", viaReal)
	}
	if viaLink == nil || !os.IsNotExist(viaLink) {
		fail("à travers la jonction, le modèle n'est pas « introuvable » : la cause supposée ne tient plus")
	}
	fmt.Println("Confirmé : à travers une jonction, Ollama ne retrouve pas un modèle pourtant présent.")
}
