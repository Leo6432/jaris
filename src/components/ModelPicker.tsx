import { useCallback, useEffect, useState } from 'react'
import type { ModelChoiceInfo, ModelChoiceMode } from '../../shared/ipc'
import { formatModelName } from '../lib/formatModelName'

/**
 * Étape 141, Léo : « ajoute dans chat code vocal, la possibilité de choisir le model ou faire auto, comme se
 * qui se passe maintenant ». Un seul composant pour les trois modes, comme le sélecteur de modèle de
 * Claude/ChatGPT posé à côté du champ de saisie : Auto (le choix automatique d'avant) ou un modèle installé.
 *
 * La liste est relue à chaque ouverture (focus) plutôt qu'une seule fois au montage : un modèle installé ou
 * supprimé entre-temps (retest, Options → Modèles) apparaît ou disparaît sans relancer Jaris.
 */
interface ModelPickerProps {
  mode: ModelChoiceMode
  disabled?: boolean
}

const AUTO = ''

function autoLabel(info: ModelChoiceInfo | null): string {
  if (info?.autoModel) return `Auto (${formatModelName(info.autoModel)})`
  return 'Auto (selon la question)'
}

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
  // Ollama injoignable : on garde le choix enregistré visible, mais sans liste à proposer.
  const models = info?.installed ?? (info?.selected ? [info.selected] : [])

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
        <option value={AUTO}>{autoLabel(info)}</option>
        {models.map((m) => (
          <option key={m} value={m}>
            {formatModelName(m)}
          </option>
        ))}
      </select>
    </label>
  )
}
