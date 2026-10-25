"""Lance Harbor pour le test Terminal-Bench 2.1 de Jaris (electron/services/terminalBench.ts).

Étape 352, Léo : « mais on mesure pas la vitesse, ouais fais en sorte qu'on fait autant d'étapes que eux ». Le test
n'a plus de limite de temps : un essai s'arrête quand le modèle dit avoir fini ou après 250 réponses du modèle.

Sans limite de temps, Terminus 2 (Harbor 0.24.0) peut tourner sans fin. Quand une réponse est trop longue (mémoire du
modèle pleine, ou `num_predict` atteint), `Terminus2._query_llm` rappelle `_query_llm` lui-même, dans le même
épisode. Ces tours ne comptent donc dans aucune des 250 étapes (`max_turns`), et rien ne les arrête : chez Artificial
Analysis, c'est leur limite de 2 h qui coupe. Ici, ces tours sont joués à plat, sans récursion (sinon Python
s'arrêterait sur « maximum recursion depth exceeded » vers une centaine de tours, ce qui relancerait toute la chaîne).
Chacun compte comme une réponse du modèle. À la 250e réponse, l'agent s'arrête comme à la fin de ses 250 étapes, et
Harbor vérifie le résultat de la tâche. Messages, consignes et réponses envoyés au modèle restent ceux de Terminus 2.
Les appels de résumé de la conversation ne comptent pas, comme chez eux.

Lancé avec `python -P` : le dossier de ce fichier (les autres scripts de Jaris) n'entre pas dans le chemin des
modules de Harbor.
"""

import os
import sys

DEFAULT_MAX_TURNS = 250


def install_turn_limit(max_turns, terminus_cls, context_length_error):
    """Borne Terminus 2 à `max_turns` réponses du modèle par essai, réponses trop longues comprises."""

    # ContextLengthExceededError n'est jamais relancé par les essais automatiques (tenacity) de _query_llm : le tour
    # suivant remonte tout de suite, sans nouvel appel au modèle.
    class _TruncatedTurn(context_length_error):
        def __init__(self, kwargs):
            super().__init__("réponse trop longue : tour suivant joué à plat par Jaris")
            self.kwargs = kwargs

    class TurnLimitReached(context_length_error):
        pass

    original_query = terminus_cls._query_llm
    original_loop = terminus_cls._run_agent_loop
    original_reset = terminus_cls._reset_per_run_state

    async def query(self, chat, prompt, original_instruction="", session=None):
        kwargs = {"chat": chat, "prompt": prompt, "original_instruction": original_instruction, "session": session}
        if getattr(self, "_jaris_in_turn", False):
            # Rappel de Terminus 2 après une réponse trop longue : rendu au tour en cours, qui le joue à plat.
            raise _TruncatedTurn(kwargs)
        while True:
            self._jaris_turns = getattr(self, "_jaris_turns", 0) + 1
            if self._jaris_turns > max_turns:
                raise TurnLimitReached(f"{max_turns} réponses du modèle")
            self._jaris_in_turn = True
            try:
                return await original_query(self, **kwargs)
            except _TruncatedTurn as following:
                kwargs = following.kwargs
            finally:
                self._jaris_in_turn = False

    async def run_loop(self, *args, **kwargs):
        try:
            return await original_loop(self, *args, **kwargs)
        except TurnLimitReached:
            # Comme à la fin des 250 étapes de Terminus 2 : l'agent s'arrête, Harbor vérifie la tâche. La ligne va
            # dans le journal de l'essai (trial.log), pour savoir après coup pourquoi l'agent s'est arrêté.
            logger = getattr(self, "logger", None)
            if logger is not None:
                logger.warning(f"Jaris : {max_turns} réponses du modèle atteintes, l'agent s'arrête.")
            return None

    def reset(self, *args, **kwargs):
        self._jaris_turns = 0
        self._jaris_in_turn = False
        return original_reset(self, *args, **kwargs)

    terminus_cls._query_llm = query
    terminus_cls._run_agent_loop = run_loop
    terminus_cls._reset_per_run_state = reset
    return TurnLimitReached


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "run":
        from harbor.agents.terminus_2.terminus_2 import Terminus2
        from harbor.llms.base import ContextLengthExceededError

        max_turns = int(os.environ.get("JARIS_TBENCH_MAX_TURNS", DEFAULT_MAX_TURNS))
        install_turn_limit(max_turns, Terminus2, ContextLengthExceededError)
    sys.argv[0] = "harbor"
    from harbor.cli.main import app

    app()


if __name__ == "__main__":
    main()
