"""Étape 352 : la borne de python/tbench_boot.py sur Terminus 2, sans Harbor ni modèle.

Le faux Terminus reproduit ce que fait le vrai (Harbor 0.24.0, agents/terminus_2/terminus_2.py) : _query_llm est
relancé jusqu'à 3 fois par tenacity, sauf sur ContextLengthExceededError ; une réponse trop longue rappelle
_query_llm lui-même, dans le même épisode ; la boucle des épisodes s'arrête à max_turns ou quand le modèle a fini.
Vérifié en vrai à part, avec Harbor, Docker et un faux Ollama qui répond toujours trop long : 6 réponses puis la
vérification de la tâche avec la borne, plus de 300 requêtes en 90 s sans jamais finir sans elle.
"""

import asyncio
import inspect
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "python"))

from tbench_boot import install_turn_limit  # noqa: E402


class ContextLengthExceededError(Exception):
    pass


def tenacity_like(fn):
    async def wrapper(*args, **kwargs):
        for attempt in range(3):
            try:
                return await fn(*args, **kwargs)
            except ContextLengthExceededError:
                raise
            except Exception:
                if attempt == 2:
                    raise
    return wrapper


def make_terminus():
    class FakeTerminus:
        def __init__(self, replies, max_episodes=250):
            self.replies = replies  # appelé avec le prompt, rend le texte ou None (réponse trop longue)
            self.max_episodes = max_episodes
            self.llm_calls = 0
            self.max_stack = 0

        def _reset_per_run_state(self):
            self.episodes = 0

        @tenacity_like
        async def _query_llm(self, chat, prompt, original_instruction="", session=None):
            # Un vrai appel au modèle rend la main à la boucle asyncio : sans ça, wait_for ne pourrait rien couper.
            await asyncio.sleep(0)
            self.llm_calls += 1
            self.max_stack = max(self.max_stack, len(inspect.stack(0)))
            reply = self.replies(prompt, self.llm_calls)
            if reply is None:
                chat.append(prompt)
                return await self._query_llm(
                    chat=chat, prompt="ERROR!! réponse trop longue", original_instruction=original_instruction,
                    session=session,
                )
            return reply

        async def _run_agent_loop(self, initial_prompt, chat, original_instruction=""):
            prompt = initial_prompt
            for episode in range(self.max_episodes):
                reply = await self._query_llm(chat, prompt, original_instruction, None)
                self.episodes += 1
                if reply == "DONE":
                    return "fini"
                prompt = f"sortie du terminal {episode}"
            return "max"

        async def run(self):
            self._reset_per_run_state()
            self.result = await self._run_agent_loop("consigne", [], "consigne")

    return FakeTerminus


def play(agent):
    # Un défaut de la borne ferait tourner l'agent sans fin : le test échoue au bout de 20 s au lieu de rester bloqué.
    asyncio.run(asyncio.wait_for(agent.run(), 20))


class TurnLimitTest(unittest.TestCase):
    def test_reponses_trop_longues_sans_fin_bornees(self):
        cls = make_terminus()
        install_turn_limit(6, cls, ContextLengthExceededError)
        agent = cls(lambda prompt, n: None)
        play(agent)
        # 6 réponses du modèle, puis l'agent s'arrête comme à la fin de ses étapes : aucune erreur, Harbor vérifie.
        self.assertEqual(agent.llm_calls, 6)
        self.assertIsNone(agent.result)

    def test_joue_a_plat_sans_recursion(self):
        cls = make_terminus()
        install_turn_limit(400, cls, ContextLengthExceededError)
        agent = cls(lambda prompt, n: None)
        play(agent)
        # Sans la mise à plat, Python s'arrêterait sur « maximum recursion depth exceeded » bien avant 400 tours.
        self.assertEqual(agent.llm_calls, 400)
        self.assertLess(agent.max_stack, 60)

    def test_episodes_normaux_inchanges(self):
        cls = make_terminus()
        install_turn_limit(250, cls, ContextLengthExceededError)
        agent = cls(lambda prompt, n: "DONE" if n == 10 else "ls")
        play(agent)
        self.assertEqual(agent.result, "fini")
        self.assertEqual(agent.llm_calls, 10)
        # Sans réponse trop longue, les 250 étapes de Terminus 2 s'arrêtent d'elles-mêmes, la borne ne joue jamais.
        agent = cls(lambda prompt, n: "ls")
        play(agent)
        self.assertEqual(agent.result, "max")
        self.assertEqual(agent.llm_calls, 250)

    def test_une_reponse_trop_longue_compte_comme_une_etape(self):
        cls = make_terminus()
        install_turn_limit(5, cls, ContextLengthExceededError)
        # Épisode 1 : deux réponses trop longues puis une bonne. Épisode 2 : une bonne. Le 3e appel de l'épisode 3
        # serait la 6e réponse : l'agent s'arrête.
        replies = {1: None, 2: None, 3: "ls", 4: "ls", 5: None}
        agent = cls(lambda prompt, n: replies.get(n))
        play(agent)
        self.assertEqual(agent.llm_calls, 5)
        self.assertEqual(agent.episodes, 2)
        self.assertIsNone(agent.result)

    def test_essais_automatiques_gardes_et_compteur_remis_a_zero(self):
        cls = make_terminus()
        install_turn_limit(3, cls, ContextLengthExceededError)
        fails = {"left": 1}

        def replies(prompt, n):
            if fails["left"]:
                fails["left"] -= 1
                raise ValueError("coupure réseau passagère")
            return "ls"

        agent = cls(replies, max_episodes=3)
        play(agent)
        # La coupure est relancée par les essais automatiques, comme avant, sans compter une réponse de plus.
        self.assertEqual(agent.result, "max")
        self.assertEqual(agent.episodes, 3)
        # Un nouvel essai sur le même agent repart de zéro.
        play(agent)
        self.assertEqual(agent.result, "max")


if __name__ == "__main__":
    unittest.main(verbosity=2)
