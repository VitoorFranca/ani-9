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

Até existir uma publicação no npm, instale o tarball do [release v0.2.0](https://github.com/VitoorFranca/ani-9/releases/tag/v0.2.0):

```bash
pnpm add https://github.com/VitoorFranca/ani-9/releases/download/v0.2.0/ani-9-core-0.2.0.tgz
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

## Estudo guiado (v0.2.0)

`@ani-9/core/study` expõe funções puras para ordenar cartões a partir de
relações revisadas, identificar pistas imediatas na sessão e registrar a etapa
de aprendizagem por cartão. A ordem é explicável; ciclos e cartões ausentes são
relatados. A regra inicial de retirada de apoio é experimental como decisão de
produto, não uma melhora de aprendizagem demonstrada. O app deve guardar
exposições e tentativas brutas e manter a revisão FSRS separada.

Pesquisa e protocolos públicos: [ani-9-benchmark](https://github.com/VitoorFranca/ani-9-benchmark).
