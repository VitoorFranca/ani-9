# ANI-9 Core

Biblioteca TypeScript aberta para processamento de cartões, conceitos, modelos experimentais e avaliação de revisões. O ANI-9 **não modifica o algoritmo nem o agendamento do FSRS**.

O código de previsão por conceito é uma linha de pesquisa, não uma melhoria validada de aprendizagem ou de recordação. Os experimentos históricos não demonstraram ganho agregado sobre o controle FSRS + baralho. O fluxo didático de estudo ainda não foi validado em teste com usuários.

## Uso

```bash
pnpm install
pnpm check
```

Os testes que baixam o modelo de embeddings são opcionais: `ANI9_RUN_MODEL_TESTS=1 pnpm test`.

## Instalação

Até existir uma publicação no npm, instale o tarball do [release v0.4.0](https://github.com/VitoorFranca/ani-9/releases/tag/v0.4.0):

```bash
pnpm add https://github.com/VitoorFranca/ani-9/releases/download/v0.4.0/ani-9-core-0.4.0.tgz
```

Depois de publicada, a biblioteca pode ser importada por `@ani-9/core` ou pelos subcaminhos `/content`, `/model`, `/concepts`, `/fsrs`, `/ingest`, `/embeddings` e `/eval`. Por exemplo:

```ts
import { buildCombinedLinks } from "@ani-9/core";

const links = buildCombinedLinks("baralho", [], {
  lambdaBase: 1,
  lambdaExtra: 0,
});
```

Os subcaminhos de conceitos, modelos e avaliação incluem APIs experimentais e podem mudar durante a série 0.x. `/ingest` e `/embeddings` requerem dependências nativas ou modelos locais. Não inclua dados pessoais ou baralhos neste repositório.

O subcaminho `/study` (v0.4.0, experimental) contém as regras do estudo
guiado: ordem por relações entre cartões com ciclos sinalizados, classificação
de respostas dadas logo após uma pista, etapas provisórias de retirada de
apoio, pares candidatos por BM25 e a conversão da resposta de um modelo de
linguagem em relações. Foram promovidas depois de um protocolo pré-registrado
no lab com critérios de versão experimental: cerca de metade das sugestões de
"estude antes" foi julgada correta, por isso as relações devem ser editáveis
por quem estuda. **Não há evidência de que essa ordem melhore a aprendizagem**;
o FSRS não é alterado. A chamada ao modelo fica a cargo de quem usa a
biblioteca.

Pesquisa e protocolos públicos: [ani-9-benchmark](https://github.com/VitoorFranca/ani-9-benchmark).
