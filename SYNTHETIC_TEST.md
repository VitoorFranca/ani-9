# Teste em dados sintéticos — `data/candy/0001-GERAL-ANI-9.apkg`

Registrado **antes de rodar**.

## Por que este teste NÃO é confirmação

Todos os 97 subbaralhos deste arquivo têm a mesma descrição: **"Baralho para testes do ANI. Conteúdo preservado; histórico de revisões inteiramente sintético."** O histórico de revisões (58.098 entradas) foi gerado artificialmente, não é comportamento real de um usuário estudando. **O resultado deste teste não conta como confirmação de `MISAEL_PROSPECTIVE_PROTOCOL.md`** — esse protocolo continua exigindo dados reais (Misael futuro, ou outro usuário real). Este teste serve só para verificar se o pipeline do modelo congelado roda corretamente numa estrutura de dados diferente (um único arquivo com hierarquia de subbaralhos aninhada, em vez de 3 arquivos), e para registrar o que aparece — nada mais.

## Adaptação necessária: "baralho" vs "tópico" numa estrutura de arquivo único

No Misael, "baralho" (nó da base) era o arquivo `.apkg` de origem (3 arquivos = 3 assuntos amplos), e "tópico" (nó de curto prazo) era o subbaralho interno do Anki. Aqui há **um único arquivo** com hierarquia `"ANI Simulado" > <área> > <subtópico específico>` (ex.: `"ANI Simulado" > "Informática" > "Excel"`). Não há divisão por arquivo para reaproveitar como "baralho".

**Adaptação registrada antes de rodar**: "baralho" = segundo segmento do caminho (a área ampla — "Informática", "Matemática", "Português" etc. — o análogo mais próximo de "assunto amplo por arquivo" do Misael), com fallback para o primeiro segmento (`"ANI Simulado"`) quando não houver segundo nível. "Tópico" = caminho completo quando há um terceiro segmento (subtópico específico dentro da área), com fallback para o rótulo de baralho (a própria área) quando o cartão está direto na área, sem subtópico mais específico — mesma lógica de fallback já usada no Misael, só reancorada um nível abaixo por causa da estrutura de arquivo único.

## Modelo e hiperparâmetros — congelados, idênticos a `MISAEL_PROSPECTIVE_PROTOCOL.md`

- **Variante**: base + nó de tópico de curto prazo (`${sessionId}::${tópico}`, reinicia a cada sessão), hiperparâmetros **congelados**: `priorVariance=1, driftPerDay=0.01, lambdaDeck=0, lambdaExtra=2`. Como `lambdaDeck=0`, a escolha exata de "baralho" acima não afeta a variante em nada.
- **FSRS**: otimizado do zero no treino deste baralho (`optimizeParameters`, split cronológico 70/30) — não reaproveita os parâmetros do Misael, mesma regra já registrada para "outro usuário".
- **Base**: FSRS (deste baralho) + nó de baralho, com hiperparâmetros do nó de baralho **ajustados no treino deste baralho** (mesma busca em grade 3D de sempre) — não congelados, mesma regra já registrada.
- **Verificação de equivalência**: `lambdaExtra=0` (mesmos `priorVariance`/`driftPerDay`/`lambdaDeck` da base) precisa reproduzir a base exatamente (tolerância <1e-12).
- **Critério e bootstrap**: idênticos — Δ log-loss (base − variante) sobre revisões espaçadas de teste, IC95% do bootstrap por sessão.

## Relato

Δ log-loss, IC95%, AUC (base e variante), tempo de execução e pico de memória.
