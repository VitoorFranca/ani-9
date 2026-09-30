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

Até existir uma publicação no npm, instale o tarball do [release v0.3.1](https://github.com/VitoorFranca/ani-9/releases/tag/v0.3.1):

```bash
pnpm add https://github.com/VitoorFranca/ani-9/releases/download/v0.3.1/ani-9-core-0.3.1.tgz
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

O subcaminho experimental `/study`, introduzido em v0.2.0, foi removido em
v0.3.0. Protótipos de organização didática e sua avaliação pertencem ao lab.

Pesquisa e protocolos públicos: [ani-9-benchmark](https://github.com/VitoorFranca/ani-9-benchmark).
