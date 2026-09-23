import { useCallback, useEffect, useState } from 'react'
import type { ModelChoiceInfo, ModelChoiceMode } from '../../shared/ipc'

/**
 * Étape 141, Léo : « ajoute dans chat code vocal, la possibilité de choisir le model ou faire auto, comme se
 * qui se passe maintenant ». Un seul composant pour les trois modes, comme le sélecteur de modèle de
 * Claude/ChatGPT posé à côté du champ de saisie : Auto ou un des cinq rôles de la configuration personnelle.
 *
 * La liste est relue à chaque ouverture (focus) : un modèle changé par le retest reste accessible sous le
 * même rôle sans que l'utilisateur voie son nom technique dans le bouton.
 */
interface ModelPickerProps {
  mode: ModelChoiceMode
  disabled?: boolean
}

const AUTO = ''

export default function ModelPicker({ mode, disabled = false }: ModelPickerProps): JSX.Element {
  const [info, setInfo] = useState<ModelChoiceInfo | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setInfo(await window.jaris.getModelChoice(mode))
    } catch {
      // Laisse l'affichage précédent : Auto reste de toute façon le comportement par défaut côté main.
    }
  }, [mode])

  useEffect(() => {
    void load()
  }, [load])

  const change = async (value: string): Promise<void> => {
    const model = value === AUTO ? null : value
    setError(null)
    setInfo((prev) => (prev ? { ...prev, selected: model } : prev))
    try {
      await window.jaris.setModelChoice(mode, model)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
    void load()
  }

  const selected = info?.selected ?? AUTO
  const legacyChoice = selected && !selected.startsWith('role:')

  return (
    <label
      className="model-picker"
      title={error ?? (info?.installed === null ? "Ollama ne répond pas : impossible de lister les modèles." : 'Modèle utilisé')}
    >
      <span className="model-picker__label">Modèle</span>
      <select
        className="model-picker__select"
        value={selected}
        disabled={disabled || info?.installed === null}
        onFocus={() => void load()}
        onChange={(e) => void change(e.target.value)}
        aria-label="Modèle utilisé"
      >
        <option value={AUTO}>Auto</option>
        {info?.roles.map((role) => (
          <option key={role.value} value={role.value} disabled={!role.installed} title={role.model}>
            {role.label}
          </option>
        ))}
        {legacyChoice && <option value={selected}>Personnalisé</option>}
      </select>
    </label>
  )
}
