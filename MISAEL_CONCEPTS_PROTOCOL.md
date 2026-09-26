# Protocolo pré-registrado — lista fixa de conceitos por LLM nos baralhos do Misael

Registrado **antes** de rodar qualquer geração de lista, classificação ou avaliação. Nada aqui deve mudar depois de ver resultados (exceto emendas explicitamente marcadas como tal, como no `MISAEL_PROTOCOL.md`).

## Contexto

Mesma pergunta do teste de vocabulário (`MISAEL_PROTOCOL.md`), mas com conceitos gerados por LLM (Gemini 3.1 Flash-Lite) em vez de palavras de vocabulário por regra — reaproveitando exatamente a infraestrutura já construída e testada para o English.apkg (`src/concepts/fixed-list.ts`, `src/concepts/classify.ts`, `src/concepts/gemini-client.ts`), sem mudanças de código nelas.

## Dados

Mesmos 3 baralhos combinados de `data/misael/`, mesma ingestão/pooling já verificado (sem colisão de `cardId`) em `MISAEL_PROTOCOL.md`. 1.571 cartões elegíveis (com conteúdo e ≥1 revisão), divididos: Língua Portuguesa=270, Direito Administrativo=982, Administração Pública=319.

## Geração da lista (uma por baralho)

- Amostra de **100 cartões** por baralho, via `selectFixedListSample(cards, 100, seed=42)` (já existente — prioriza cartões de frase sobre palavra única, para maximizar variedade de padrões na amostra).
- Gerada por `generateFixedList` (`src/concepts/fixed-list.ts`, prompt já existente, sem alterações), modelo `gemini-3.1-flash-lite`, `thinkingLevel: MINIMAL`.
- Regras já embutidas no prompt (confirmadas contra o pedido): dois conceitos são diferentes se alguém pode saber um sem o outro; cada conceito deve aparecer em ≥3 cartões da amostra; cita os IDs de 2 cartões de exemplo por conceito; conceitos atômicos (uma ideia por conceito); vocabulário de palavra única é excluído (coberto por regra separada, não por LLM); entre 30 e 80 conceitos por lista.
- **As 3 listas geradas são mostradas ao usuário, que revisa antes de qualquer classificação prosseguir.**

## Classificação

- Cada cartão elegível do baralho recebe, da lista fixa **daquele baralho** (não misturando listas entre baralhos), os conceitos que exige — pode ser nenhum. Via `classifyCards` (`src/concepts/classify.ts`, sem alterações), `batchSize=30` (padrão).
- **20 cartões aleatórios (seed fixa) são mostrados com seus conceitos atribuídos, para auditoria pelo usuário**, antes da avaliação prosseguir.

## Avaliação (mesmo protocolo do teste de vocabulário)

- **Base**: FSRS + nó por baralho (reaproveitando exatamente `deckTest`/`deckGrid` já calculados em `analyze-misael.mts`, sem recomputar).
- **Variante**: base + conceitos da lista fixa, no mesmo cartão, com **λ separados** (`lambdaDeck`, `lambdaConcept`) — mesma correção já aplicada e testada no teste de vocabulário (evita o bug de diluição de peso do deck e o bug do fallback de cartão sem baralho atribuído). Grade: `priorVariance ∈ {0.25, 1}`, `driftPerDay ∈ {0.001, 0.01}`, `lambdaDeck ∈ {0, 0.25, 0.5, 1, 2}`, `lambdaConcept ∈ {0, 0.25, 0.5, 1, 2}` (4D, 100 combinações) — mesma grade do teste de vocabulário.
- **Verificação de equivalência** (obrigatória antes de aceitar qualquer resultado, mesmo procedimento que pegou o bug real no teste de vocabulário): com `lambdaConcept=0` e os mesmos `priorVariance`/`driftPerDay`/`lambdaDeck` do controle "deck sozinho", a variante precisa reproduzir exatamente (diferença ponto-a-ponto < 1e-12) o controle "deck sozinho" no teste.
- **Bootstrap por cartão, 3.000 iterações**, variante vs base. **Se o IC95% não estiver inteiramente a favor da variante, o teste para aqui — não roda permutação, resultado registrado como final** (mesma regra de decisão do teste de vocabulário).
- **Se o IC estiver a favor**: permutação de 1.000x, embaralhando **só a atribuição de conceitos da lista** (rótulo de deck permanece fixo em cada permutação), refazendo a grade 4D a cada permutação — critério de sucesso final exige IC a favor **e** p<0,05.

## Custo e aprovação

**Nenhuma chamada ao Gemini é feita sem aprovação explícita prévia**, para geração de lista OU classificação. Estimativa abaixo, calculada a partir de contagens reais de cartões e tamanho médio de texto (não um chute):

- Geração de lista: 3 chamadas (uma por baralho), ~9.000 tokens de entrada e ~1.850 de saída cada (amostra de 100 cartões, ~85 tokens/cartão + lista de 30-80 conceitos gerada) → **≈ US$0,015** no total.
- Classificação: lotes de 30 cartões/chamada → 9 + 33 + 11 = **53 chamadas**, ~3.675 tokens de entrada e ~700 de saída cada → **≈ US$0,104** no total.
- **Total estimado: ≈ US$0,12** (com margem, algo entre US$0,10 e US$0,15), preço `gemini-3.1-flash-lite`: US$0,25/1M tokens de entrada, US$1,50/1M de saída (mesmo preço já verificado e usado no English.apkg).

## Restrição

Nenhuma outra chamada de API além do Gemini para geração de lista e classificação, ambas explicitamente aprovadas por etapa.

## Emenda registrada ANTES de regenerar as listas (após ver a 1ª rodada abaixo do mínimo)

A 1ª rodada de geração (amostra de 100 cartões/baralho, alvo de 30-80 conceitos no prompt) produziu listas bem abaixo do mínimo pedido: 17 (Língua Portuguesa), 6 (Direito Administrativo), 10 (Administração Pública) — custo real US$0,01217, salvo em `cache/misael-fixed-list-*.json`. Decisão do usuário, registrada antes de rodar de novo:

- **Removido o alvo numérico (30-80) do prompt** — `generateFixedList`/`buildFixedListPrompt` ganharam a opção `includeCountTarget` (padrão `true`, preservando o comportamento já usado no English.apkg); aqui usa-se `includeCountTarget: false`.
- **Amostra maior e assimétrica por baralho**:
  - Língua Portuguesa: **todos os 270 cartões elegíveis** (não mais amostra de 100).
  - Administração Pública: **todos os 319 cartões elegíveis**.
  - Direito Administrativo: **300 cartões variados** (de 982 elegíveis), via `selectFixedListSample(cards, 300, seed=42)` (mesma priorização de cartões de frase).
- Mantidas: regra de ≥3 cartões da amostra por conceito, citação de 2 exemplos por conceito.
- **Teto de custo total continua US$0,20** (já gasto: US$0,01217 da 1ª rodada).
- **Estimativa da regeneração** (mesma metodologia, a partir de tamanho médio real de texto por baralho: ~297/279/271 caracteres): Língua Portuguesa ≈23.450 tokens de entrada, Direito Administrativo ≈26.000, Administração Pública ≈27.615; saída estimada com folga (~1.800 tokens/baralho, incerta sem o alvo numérico) → **≈ US$0,03 adicionais**, total acumulado estimado ≈ **US$0,04-0,05**, bem abaixo do teto de US$0,20.
- **Relato pós-regeneração**: por baralho, número de conceitos e uma estimativa de cobertura baseada só nos exemplos citados na amostra (quantos cartões distintos da amostra são citados como exemplo de pelo menos 1 conceito, dividido pelo tamanho da amostra) — não é a cobertura real do baralho inteiro, que só é conhecida após a classificação (próxima etapa, ainda pendente de aprovação separada).

## Emenda: variante extra de nó por tópico (subbaralho)

Verificado sem API, antes da classificação: os 3 `.apkg` têm subbaralhos reais (nomes com separador `\x1f`, ex. `"04. Direito Administrativo" > "04.1 Noções, Orig, Fonte, Regimes; Princíp e Atos"`), lidos direto da tabela `decks` (não fazia parte do pipeline de ingestão existente, que só usava `did` numérico). Tags são irrelevantes (0-1,9% dos cartões, só a tag "leech").

Cobertura por subbaralho, sobre cartões elegíveis:

| Baralho | Sem subbaralho | Com subbaralho | Subbaralhos distintos |
|---|---|---|---|
| Língua Portuguesa | 216/270 (80,0%) | 54/270 (20,0%) | 5 |
| Direito Administrativo | 2/982 (0,2%) | **980/982 (99,8%)** | 8 |
| Administração Pública | 249/319 (78,1%) | 70/319 (21,9%) | 4 |
| **Pooled** | 467/1.571 (29,7%) | **1.104/1.571 (70,3%)** | 17 |

A cobertura pooled (70,3%) cruza o limiar de "alta" definido para acionar a variante extra — **mas é puxada quase inteiramente pelo Direito Administrativo** (99,8%); os outros dois baralhos têm cobertura baixa (20-22%, maioria dos cartões sem subtópico). Registrado explicitamente: a variante de tópico pode acabar sendo, na prática, largamente um efeito do Direito Administrativo sozinho, não um sinal de tópico genuíno e uniforme nos 3 baralhos — mesmo tipo de confundimento já visto no notetype do English.apkg.

**Variante extra adicionada, mesmo protocolo de λ separados/bootstrap/permutação do teste de vocabulário e da lista fixa**:
- **Tópico de um cartão** = caminho do subbaralho (`"baralho > subbaralho"`) quando o cartão está em algum subbaralho; senão, cai no próprio rótulo de baralho (`deck:X`) como valor de tópico — garante que todo cartão tenha um valor de tópico definido.
- **Variante**: base (FSRS + nó por baralho) + nó por tópico, com `lambdaDeck`/`lambdaTopico` separados, mesma grade 4D.
- **Verificação de equivalência**: com `lambdaTopico=0`, idêntica ao controle "deck sozinho" (mesmo procedimento e mesma tolerância <1e-12 já usados).
- **Bootstrap 3.000x**; se o IC não estiver inteiramente a favor, para aqui, resultado final. Se estiver a favor, permutação 1.000x (só do tópico, deck fixo).
