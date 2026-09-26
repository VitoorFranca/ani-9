# Protocolo pré-registrado — confirmação em `open-spaced-repetition/anki-revlogs-10k`

Registrado **antes de baixar qualquer coisa**. Nada aqui muda depois de ver dados ou resultados.

## Contexto

Terceiro teste de confirmação fora da amostra do achado exploratório "nó de tópico de curto prazo" (`MISAEL_CONCEPTS_PROTOCOL.md`, congelado em `MISAEL_PROSPECTIVE_PROTOCOL.md`). O teste em `data/candy/` não contou (histórico sintético, `SYNTHETIC_TEST.md`). Este usa um dataset público de revlogs reais de ~10 mil usuários do Anki, agregado — múltiplos usuários reais, ao contrário de qualquer teste anterior deste projeto.

## Modelo e hiperparâmetros — congelados, idênticos a `MISAEL_PROSPECTIVE_PROTOCOL.md`

- **Variante**: base (baralho) + nó de tópico de curto prazo, hiperparâmetros **congelados**: `priorVariance=1, driftPerDay=0.01, lambdaDeck=0, lambdaExtra=2`. Como `lambdaDeck=0`, a variante não depende do nó de baralho.
- **FSRS**: otimizado do zero, **por usuário**, no treino daquele usuário (`optimizeParameters`, split cronológico 70/30) — mesma regra já usada para "outro usuário" em `MISAEL_PROSPECTIVE_PROTOCOL.md`.
- **Base**: FSRS (daquele usuário) + nó de baralho, hiperparâmetros do nó de baralho **ajustados no treino daquele usuário** (mesma busca em grade 3D de sempre) — não congelados.

## Emendas necessárias para este dataset (registradas antes de ver os dados)

- **Sessão** = mesmo `day_offset` (este dataset não tem horário exato de revisão, só um deslocamento em dias) — todas as revisões de um usuário no mesmo `day_offset` formam uma sessão. Mais grosseiro que a janela de <30min usada no Misael; é o melhor disponível dado o formato do dataset.
- **Tópico** = `deck_id` do cartão diretamente (não um caminho derivado).
- **Baralho** (nó da base) = deck pai do cartão (`parent_id` do deck do cartão).
- **Revisão espaçada** = `elapsed_days >= 1` (campo do próprio dataset, se disponível como tal; senão, recalculado a partir do campo de tempo disponível — a confirmar na inspeção).

## Amostragem de usuários

- **Amostra aleatória de 200 usuários**, semente fixa, do total de usuários do dataset.
- **Critério de inclusão**: usuário só entra se (a) tiver **≥2 níveis de hierarquia de decks** (pelo menos um deck com `parent_id` genuíno, não nulo/raiz) — sem isso, "tópico" (deck_id) e "baralho" (deck pai) colapsam no mesmo nível; e (b) tiver **≥30 falhas espaçadas no seu próprio split de teste**.
- **Mínimo agregado antes de avaliar**: soma de **≥150 falhas espaçadas no teste**, somando todos os usuários incluídos. Abaixo disso, só se reporta a contagem, sem calcular Δ nem IC.

## Critério de sucesso

**Δ log-loss agregado** (base − variante, pooling das previsões de teste de todos os usuários incluídos) com **IC95% do bootstrap por usuário** (`bootstrapLogLossDeltaByGroup`, agrupado por `user_id`, mesma convenção já usada no teste do KARL) **inteiramente a favor da variante**.

## Emenda registrada ANTES das contagens: definição precisa de raiz, profundidade e fallback

- **Raiz**: um deck cujo `parent_id` é nulo, `0`, ou não existe na tabela `decks` daquele usuário (referência pendurada) — tratado como raiz por segurança, não como erro.
- **Profundidade** de um deck = número de passos até a raiz (raiz em si tem profundidade 0; filho direto da raiz tem profundidade 1; e assim por diante). Resolvida com proteção contra ciclo (conjunto de visitados), defensiva contra dados malformados.
- **"≥2 níveis" (critério de inclusão do usuário)**: o usuário tem pelo menos um cartão cujo deck tem **profundidade ≥2** (ou seja, o pai desse deck não é raiz — é um deck real, intermediário).
- **Tópico** = `deck_id` do cartão, **baralho** = `parent_id` desse deck — só quando o deck do cartão tem profundidade ≥2 (seu pai é um deck real, não raiz).
- **Fallback (cartões em decks de profundidade 0 ou 1)**: entram só com o nó de baralho, sem tópico genuíno — mesma convenção do Misael. `baralho = deck_id` do próprio deck do cartão (não há pai melhor disponível); `tópico` cai no mesmo rótulo do baralho (`deck:${deckId}`, mesma string usada como fallback em `MISAEL_CONCEPTS_PROTOCOL.md`). Profundidade 0 é um caso degenerado (cartão diretamente numa raiz) não mencionado explicitamente no pedido original, mas tratado pela mesma regra por consistência.

## Fonte de dados e licença

- **Repositório oficial**: `open-spaced-repetition/anki-revlogs-10k` no Hugging Face. **Só a fonte oficial** — nenhuma cópia de terceiros.
- Download autenticado via `HF_TOKEN` do `.env` (valor nunca impresso).
- Antes de baixar a amostra completa: listar a estrutura de arquivos, baixar só a licença e os dados de **um usuário** (revlogs, cards, decks), reportar formato/tamanho/memória e o que a licença permite — **parar** para aprovação antes de prosseguir.
- Com aprovação: baixar a amostra de 200 usuários, **um de cada vez**, reportando só contagens — **parar** de novo antes de calcular qualquer Δ ou efeito.

## Restrição

Sem chamada a API de modelo (Anthropic, Google etc.). Acesso ao Hugging Face é só para baixar dados, autenticado com `HF_TOKEN`.
