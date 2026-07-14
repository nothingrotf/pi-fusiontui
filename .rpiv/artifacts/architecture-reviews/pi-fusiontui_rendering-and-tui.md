---
template_version: 1
date: 2026-07-13T22:47:34-0300
author: Gabriel Aguiar
commit: a38a39b
branch: main
repository: pi-fusiontui
target: .
target_kind: directory
layer_count: 5
phases: [{ n: 1, title: "Primitivas seguras de boundary", depends_on: [], blast_radius: internal, effort: M }, { n: 2, title: "Contratos de configuração e atividade", depends_on: [1], blast_radius: on-disk, effort: M }, { n: 3, title: "Frescor assíncrono e responsividade", depends_on: [2], blast_radius: internal, effort: M }, { n: 4, title: "Geometria do frame e recuperação", depends_on: [1, 2, 3], blast_radius: cross-module, effort: L }, { n: 5, title: "Texto seguro e limites de transcript", depends_on: [4], blast_radius: cross-module, effort: L }, { n: 6, title: "Ownership e teardown de recursos", depends_on: [5], blast_radius: cross-module, effort: L }, { n: 7, title: "Capabilities de terminal", depends_on: [5, 6], blast_radius: internal, effort: M }]
unresolved_finding_count: 0
status: ready
tags: [architecture-review, pi-fusiontui, tui, rendering, lifecycle]
last_updated: 2026-07-13T22:47:34-0300
last_updated_by: Gabriel Aguiar
last_updated_note: "Initial audit skeleton"
---

# Architecture review — pi-fusiontui

Auditoria estática do repositório atual, com foco em falhas de renderização, estabilidade do TUI, lifecycle e integração com as APIs do Pi. O escopo inclui a extensão em `extensions/fusion`, os temas empacotados e os arquivos de configuração diretamente relacionados; `node_modules` e dependências externas ficam fora da revisão. O worktree já continha alterações não commitadas no início da auditoria; nenhuma alteração de código será feita pela revisão.

---

## Conventions

### Finding shape

Each finding is a level-3 heading `### L<layer>-<seq> — <title>` followed by the fields below.

| Field | Meaning |
|---|---|
| **Evidence** | `file.ext:lineA-lineB` (+ short quote when useful) |
| **Current state** | what the code does today |
| **Desired state** | what we want it to look like |
| **Proposed improvement** | concrete action (rename, extract, merge, split, delete) |
| **Severity** | Low / Med / High — how wrong this is today |
| **Effort** | S / M / L — bounded changes ship cheaply |
| **Blast radius** | `internal` / `public-API` / `on-disk` / `cross-module` |
| **Class** | `polish` (rename / refactor / DRY) vs `redesign` (structural shift) |
| **Status** | `open` / `accepted` / `rejected` / `deferred` / `withdrawn` |
| **Depends on** | other finding IDs that must land first |
| **Cross-cut tag** | optional — see "Cross-cutting themes" |

### Status legend

- `open` — flagged, not yet triaged
- `accepted` — will land; includes the chosen option summary
- `rejected` — declined with reason inline
- `deferred` — accepted in principle but punted post-release
- `withdrawn` — initial diagnosis turned out incorrect; kept for audit

### Layers (top → down)

| # | Layer | Files |
|---|---|---|
| 0 | Entrada e integração | `extensions/fusion/index.ts` |
| 1 | Estado e configuração | `extensions/fusion/state.ts`, `extensions/fusion/config.ts` |
| 2 | Dados, formatação e tema | `extensions/fusion/git.ts`, `extensions/fusion/usage.ts`, `extensions/fusion/format.ts`, `extensions/fusion/theme.ts` |
| 3 | Superfícies principais | `extensions/fusion/footer.ts`, `extensions/fusion/editor.ts` |
| 4 | Skin de transcript, patches e notificações | `extensions/fusion/droid.ts`, `extensions/fusion/sound.ts` |

---

## Methodology principles

### M1 — Fronteiras normalizam antes de compor o frame

**Origin:** L2-04, L3-03 e L4-02; valores externos inválidos, quebras e controles foram identificados como causas de corrupção visual.

**Rule.** Dados de APIs, extensões, tools e arquivos persistidos devem ser validados, normalizados e limitados antes de entrar em strings de renderização. A camada de UI não deve confiar que `visibleWidth`/truncamento corrigirá controles físicos ou estados inválidos.

**Apply to (keep):**
- Formatters e parsers com fallback estável (`--`, vazio ou resumo seguro).
- Sanitização de linhas, OSC/SGR permitidos e limites de conteúdo.

**Apply to (drop / change):**
- Strings externas concatenadas diretamente em linhas do footer/transcript.
- `NaN`, quebras, carriage returns e escapes de cursor vazando para o terminal.

### M2 — Geometria TUI é um contrato rígido

**Origin:** L3-01, L3-02, L3-04 e L4-03; wrapping físico e altura variável foram tratados como riscos de primeira classe.

**Rule.** Cada componente deve retornar exatamente linhas que cabem na largura recebida e deve declarar uma política de altura estável por modo. Fallbacks estreitos, status opcionais e expansão de conteúdo não podem alterar o frame de forma implícita.

**Apply to (keep):**
- Truncamento por largura visível e reservas explícitas de linhas.
- Fallback compacto que preserva feedback essencial.

**Apply to (drop / change):**
- Padding fixo que excede `width`.
- Linhas extras condicionais em modos anunciados como one-line.
- Cards que retornam vazio sem estado mínimo.

### M3 — Recursos e patches têm ownership explícito

**Origin:** L0-05, L4-05 e L4-08; cleanup incondicional e callbacks/processos tardios ameaçam outras superfícies.

**Rule.** Toda factory, monkey-patch, timer, listener, Promise e child process instalado pela extensão deve ter owner verificável, ser invalidado no teardown e não sobrescrever trabalho posterior de terceiros. Falhas assíncronas devem ser idempotentes.

**Apply to (keep):**
- Guards de identidade antes de restaurar protótipos/componentes.
- Geração/cancelamento para tarefas e settle único para playback.

**Apply to (drop / change):**
- `setFooter(undefined)`/unpatch incondicional.
- Callbacks que atualizam estado após a sessão/provider mudar.
- Processos e intervalos sem registry/cleanup.


---

## Layer 0 — Entrada e integração

Files: `extensions/fusion/index.ts`

### L0-01 — Decisão de redraw usa frame anterior

**Evidence**

`extensions/fusion/index.ts:440-456` — `syncInteractive()` agenda render e `frameOverflowsFn?.()` é consultado no mesmo callback de `agent_end`.

**Current state**

A escolha entre resync barato e scrub completo lê `previousLines` antes de o render agendado refletir as mudanças de estado/footer. Um frame que acabou de crescer pode ser classificado como cabível e deixar linhas duplicadas ou bordas quebradas.

**Desired state**

A decisão deve observar o frame efetivamente pintado, ou adotar uma recuperação conservadora quando a forma do UI mudou.

**Proposed improvement**

Reavaliar overflow depois do ciclo de render (ou agendar o scrub no callback do frame) e cobrir a transição de footer/editor com um teste de viewport estreito.

- **Severity:** High
- **Effort:** M
- **Blast radius:** internal
- **Class:** redesign
- **Status:** **accepted** — corrigir a decisão para ocorrer após o render efetivo.
- **Depends on:** none
- **Cross-cut tag:** `T1-render-synchronization`

### L0-02 — Scrub pendente pode ficar indefinido durante composição

**Evidence**

`extensions/fusion/index.ts:118-130, 416-420` — texto não vazio retorna após marcar `scrubPending`, mas o flag só é consumido em `agent_start`.

**Current state**

Se o agente termina enquanto o usuário continua digitando, o próximo `agent_start` pode nunca acontecer e o redraw completo que deveria limpar scrollback fica pendente indefinidamente.

**Desired state**

A limpeza deve acontecer no primeiro ponto seguro de ociosidade, sem interromper a composição atual.

**Proposed improvement**

Adicionar uma oportunidade de consumo no próximo idle/editor-empty ou após o envio/limpeza do editor, com coalescência para evitar múltiplos scrubs.

- **Severity:** Med
- **Effort:** M
- **Blast radius:** internal
- **Class:** redesign
- **Status:** **accepted** — consumir a limpeza no próximo estado idle seguro.
- **Depends on:** L0-01
- **Cross-cut tag:** `T1-render-synchronization`

### L0-03 — Leituras Git concorrentes aceitam respostas antigas

**Evidence**

`extensions/fusion/index.ts:265-267, 386-390, 481-487` — eventos, timer e callbacks de tools iniciam `readGitStatus()` sem serialização ou geração.

**Current state**

Várias consultas podem rodar ao mesmo tempo; uma leitura mais antiga que termina por último sobrescreve `state.git` atual e solicita uma repintura. Em sessões com tools paralelos isso também cria processos desnecessários.

**Desired state**

No máximo uma leitura deve estar ativa por contexto e apenas o resultado da geração mais recente pode atualizar o estado/render.

**Proposed improvement**

Serializar/coalescer `refreshGit`, invalidar resultados obsoletos por geração e cancelar ou ignorar callbacks após teardown.

- **Severity:** Med
- **Effort:** M
- **Blast radius:** internal
- **Class:** redesign
- **Status:** **accepted** — serializar e invalidar leituras Git fora de ordem.
- **Depends on:** none
- **Cross-cut tag:** `T2-async-freshness`

### L0-04 — Usage antigo pode reaparecer após troca de provider

**Evidence**

`extensions/fusion/index.ts:283-301, 386-388` — provider não suportado limpa `state.usage`, mas não invalida `activeProvider` nem a task anterior.

**Current state**

O timer pode continuar buscando o provider anterior e uma Promise pendente pode repopular o footer após uma troca de modelo, exibindo janelas de uso para o provider errado.

**Desired state**

Trocas de provider devem invalidar tarefas antigas, limpar o provider ativo quando não há API compatível e impedir dados atrasados no footer.

**Proposed improvement**

Usar um contador de geração/AbortController para usage, limpar `activeProvider` ao retornar `null` e iniciar o timer apenas para provider suportado.

- **Severity:** Med
- **Effort:** M
- **Blast radius:** internal
- **Class:** redesign
- **Status:** **accepted** — limpar provider e usar geração para invalidar consultas antigas.
- **Depends on:** none
- **Cross-cut tag:** `T2-async-freshness`

### L0-05 — Shutdown pode remover superfícies de terceiros

**Evidence**

`extensions/fusion/index.ts:494-510` — cleanup sempre chama `setFooter(undefined)` e `setEditorComponent(undefined)`.

**Current state**

Se outra extensão substituiu o footer ou editor depois da instalação do Fusion, o shutdown do Fusion remove o componente atual sem verificar ownership.

**Desired state**

O cleanup deve restaurar apenas o que a própria extensão instalou, sem destruir uma superfície que pertence a outra extensão.

**Proposed improvement**

Guardar referências/identidade das factories instaladas e aplicar ownership guard antes de restaurar footer, editor e patches.

- **Severity:** Med
- **Effort:** M
- **Blast radius:** cross-module
- **Class:** redesign
- **Status:** **accepted** — adicionar ownership guard no cleanup.
- **Depends on:** none
- **Cross-cut tag:** `T3-lifecycle-ownership`

### L0-06 — Label de awaiting é sobrescrito por tools concorrentes

**Evidence**

`extensions/fusion/index.ts:462-487` — tools comuns alteram `workingLabel` sem consultar `awaitingToolIds`.

**Current state**

Uma pergunta pendente mantém a borda em estado warning, mas o texto pode mudar para `Invoking tools...` ou `Thinking...`, contradizendo o estado exibido e confundindo a ação esperada do usuário.

**Desired state**

Enquanto houver qualquer ask pendente, border, estado e label devem permanecer coerentes com `Waiting for your input...`.

**Proposed improvement**

Centralizar a derivação de `agent`/label em uma função que priorize `awaitingToolIds.size > 0` e só volte a working após a última ask terminar.

- **Severity:** Med
- **Effort:** S
- **Blast radius:** internal
- **Class:** polish
- **Status:** **accepted** — derivar a renderização do conjunto de asks pendentes.
- **Depends on:** L1-03
- **Cross-cut tag:** `T4-state-render-coherence`

### L0-07 — Pacotes agrupados de foco podem vazar para o editor

**Evidence**

`extensions/fusion/index.ts:378-382` — apenas strings exatamente iguais a `\x1b[I`/`\x1b[O` são consumidas.

**Current state**

Se o terminal entrega uma sequência de foco junto com outros bytes, o callback não a remove e esses bytes podem ser interpretados como entrada do editor.

**Desired state**

O parser de input deve reconhecer sequências de foco dentro de pacotes agrupados e preservar apenas os bytes de texto/controle destinados ao editor.

**Proposed improvement**

Adicionar um parser incremental de sequências CSI de foco, com buffer para escapes parciais e testes de pacotes agrupados.

- **Severity:** Low
- **Effort:** M
- **Blast radius:** internal
- **Class:** redesign
- **Status:** **accepted** — parsear foco em stream antes de encaminhar input.
- **Depends on:** none
- **Cross-cut tag:** `T3-lifecycle-ownership`

### Layer 0 — tally

| Status | Count |
|---|---|
| accepted | 7 |
| rejected | 0 |
| deferred | 0 |
| withdrawn | 0 |

Cross-cutting tags introduced: `T1-render-synchronization`, `T2-async-freshness`, `T3-lifecycle-ownership`, `T4-state-render-coherence`.
Cross-cutting tags reused: `T1-render-synchronization` (L0-02), `T2-async-freshness` (L0-04), `T3-lifecycle-ownership` (L0-07).

Dependency edges within Layer 0:

- L0-02 depends on L0-01 (scrub scheduling should use the corrected render timing).

---

## Layer 1 — Estado e configuração

Files: `extensions/fusion/state.ts`, `extensions/fusion/config.ts`

### L1-01 — Valores de som inválidos passam pela configuração

**Evidence**

`extensions/fusion/config.ts:53-68` — qualquer string não vazia é convertida para `SoundValue` por cast.

**Current state**

Configurações corrompidas ou valores arbitrários persistidos são aceitos e repassados ao player, podendo gerar notificações que dizem ter configurado um som mas não conseguem reproduzi-lo.

**Desired state**

O loader deve aceitar somente valores conhecidos ou caminhos customizados válidos e retornar um default previsível para dados inválidos.

**Proposed improvement**

Criar um guard central para `SoundValue`, validar enum e caminho absoluto, normalizar o valor carregado e emitir aviso quando houver fallback.

- **Severity:** Med
- **Effort:** S
- **Blast radius:** internal
- **Class:** polish
- **Status:** **accepted** — validar valores antes de colocá-los no estado.
- **Depends on:** none
- **Cross-cut tag:** `T5-config-integrity`

### L1-02 — Persistência de configuração não é atômica

**Evidence**

`extensions/fusion/config.ts:71-77` — read-modify-write direto em `fusiontui.json`, sem lock ou arquivo temporário.

**Current state**

Atualizações concorrentes podem perder campos ou deixar o JSON truncado caso o processo seja interrompido durante `writeFileSync`.

**Desired state**

Cada atualização deve preservar o conteúdo anterior e produzir um arquivo completo ou o arquivo anterior, nunca um estado parcial.

**Proposed improvement**

Serializar gravações no processo e escrever para um temporário no mesmo diretório seguido de `rename`, mantendo permissões e tratando falha de forma observável.

- **Severity:** Med
- **Effort:** M
- **Blast radius:** on-disk
- **Class:** redesign
- **Status:** **accepted** — adotar escrita atômica e coalescer atualizações.
- **Depends on:** L1-01
- **Cross-cut tag:** `T5-config-integrity`

### L1-03 — Estado permite atividade e label incoerentes

**Evidence**

`extensions/fusion/state.ts:16-29` — `agent` e `workingLabel` são campos mutáveis independentes, e `index.ts` os atualiza em etapas diferentes.

**Current state**

É possível renderizar borda idle/awaiting com label de outra atividade, porque o tipo não representa uma transição coerente da máquina de estados.

**Desired state**

Border, atividade e label devem derivar de uma única fonte de verdade, com combinações inválidas impossíveis ou explicitamente tratadas.

**Proposed improvement**

Introduzir um estado discriminado/view model para atividade e uma função única de atualização usada pelo editor/footer, mantendo labels específicos fora da renderização quando necessário.

- **Severity:** Med
- **Effort:** M
- **Blast radius:** internal
- **Class:** redesign
- **Status:** **accepted** — derivar uma view coerente para atividade e label.
- **Depends on:** none
- **Cross-cut tag:** `T4-state-render-coherence`

### Layer 1 — tally

| Status | Count |
|---|---|
| accepted | 3 |
| rejected | 0 |
| deferred | 0 |
| withdrawn | 0 |

Cross-cutting tags introduced: `T4-state-render-coherence`, `T5-config-integrity`.
Cross-cutting tags reused: `T4-state-render-coherence` (L1-03), `T5-config-integrity` (L1-02).

Dependency edges within Layer 1:

- L1-02 depends on L1-01 (centralizar a validação antes da persistência).

---

## Layer 2 — Dados, formatação e tema

Files: `extensions/fusion/git.ts`, `extensions/fusion/usage.ts`, `extensions/fusion/format.ts`, `extensions/fusion/theme.ts`

### L2-01 — CWD perde contexto e tem falso match de home

**Evidence**

`extensions/fusion/format.ts:83-89` — usa `p.startsWith(home)` e retorna apenas `parts[parts.length - 1]`.

**Current state**

Diretórios irmãos como `/home/alice2` podem ser abreviados incorretamente como se estivessem sob `/home/alice`; além disso, o footer mostra só o basename, contrariando o caminho abreviado documentado.

**Desired state**

A abreviação deve respeitar fronteiras de diretório e manter contexto suficiente para distinguir projetos próximos, truncando por largura apenas na camada de layout.

**Proposed improvement**

Usar comparação por segmento/`relative`, preservar `~` e os últimos segmentos definidos pelo design, e deixar `justify` aplicar a truncagem final.

- **Severity:** Low
- **Effort:** S
- **Blast radius:** internal
- **Class:** polish
- **Status:** **accepted** — corrigir fronteira de home e preservar caminho útil.
- **Depends on:** none
- **Cross-cut tag:** `T6-input-normalization`

### L2-02 — Timeout de usage não cobre o body da resposta

**Evidence**

`extensions/fusion/usage.ts:57-64, 75, 109` — o timer é limpo assim que `fetch()` retorna, antes de `res.json()`.

**Current state**

Um servidor pode entregar headers e travar no body; a Promise fica pendente, o timer periódico acumula tasks e o footer conserva um estado antigo sem feedback.

**Desired state**

Toda a operação de rede, incluindo consumo e parsing do body, deve ter prazo e ser descartável quando expirada.

**Proposed improvement**

Manter o `AbortSignal` até o parse completo, envolver o consumo em timeout e combinar com a geração do provider para ignorar respostas expiradas.

- **Severity:** Med
- **Effort:** M
- **Blast radius:** internal
- **Class:** redesign
- **Status:** **accepted** — cobrir também o body com timeout efetivo.
- **Depends on:** L0-04
- **Cross-cut tag:** `T2-async-freshness`

### L2-03 — Fallback de keychain bloqueia o event loop

**Evidence**

`extensions/fusion/usage.ts:35-46` — `getClaudeToken()` usa `execSync` sem timeout durante a inicialização do usage.

**Current state**

Em macOS com keychain lento/bloqueado, a primeira pintura e a entrada do usuário ficam congeladas até o subprocesso terminar.

**Desired state**

A TUI deve pintar primeiro e consultar credenciais em background, com timeout e fallback que não bloqueie o loop.

**Proposed improvement**

Tornar a busca de keychain assíncrona, limitar sua duração e iniciar a atualização de usage depois do primeiro render.

- **Severity:** Med
- **Effort:** M
- **Blast radius:** internal
- **Class:** redesign
- **Status:** **accepted** — tornar o lookup assíncrono e limitado.
- **Depends on:** L2-02
- **Cross-cut tag:** `T2-async-freshness`

### L2-04 — Formatters deixam valores inválidos chegarem ao footer

**Evidence**

`extensions/fusion/format.ts:68-74, 92-103` — percentuais/datas não finitos podem resultar em `NaN%` ou `NaNd`.

**Current state**

Payloads incompletos ou alterados de Pi/API podem produzir labels que poluem a linha de status e não explicam que o dado está indisponível.

**Desired state**

Entradas não finitas devem resultar em marcadores estáveis (`--`, `?` ou `now`) sem exceção nem texto `NaN`.

**Proposed improvement**

Validar `Number.isFinite`, datas válidas e limites no boundary dos formatters, adicionando casos de payload malformado.

- **Severity:** Med
- **Effort:** S
- **Blast radius:** internal
- **Class:** polish
- **Status:** **accepted** — normalizar percentuais e datas antes de formatar.
- **Depends on:** none
- **Cross-cut tag:** `T6-input-normalization`

### L2-05 — Barra de progresso pode lançar por largura inválida

**Evidence**

`extensions/fusion/theme.ts:38-42` — `BAR_FILLED.repeat(filled)` e `BAR_EMPTY.repeat(empty)` usam largura calculada sem guarda.

**Current state**

Uma largura negativa, não finita ou fracionária vinda de cálculo de layout pode causar `RangeError` dentro do render do footer, interrompendo a pintura inteira.

**Desired state**

O helper deve ser total: qualquer largura inválida resulta em uma barra vazia/limitada, nunca em exceção de render.

**Proposed improvement**

Normalizar width para inteiro não negativo, limitar o comprimento máximo e tratar percentuais não finitos antes de chamar `repeat`.

- **Severity:** High
- **Effort:** S
- **Blast radius:** internal
- **Class:** polish
- **Status:** **accepted** — tornar o helper total-safe.
- **Depends on:** none
- **Cross-cut tag:** `T7-layout-safety`

### L2-06 — Resumo Git ignora estados além de M

**Evidence**

`extensions/fusion/git.ts:58-64` — `modified` só incrementa quando `y === "M"`; adições, deleções, renames e cópias ficam fora do contador.

**Current state**

O footer pode indicar um repositório dirty sem refletir a quantidade/tipo de mudanças que o usuário espera do resumo.

**Desired state**

O parser e o modelo devem definir e contar de forma consistente todos os estados exibidos pela UI.

**Proposed improvement**

Mapear os códigos XY de porcelain v2 para categorias explícitas (added/deleted/renamed/copied/modified/conflicted) e alinhar labels/contadores do footer.

- **Severity:** Low
- **Effort:** M
- **Blast radius:** internal
- **Class:** polish
- **Status:** **accepted** — contar estados completos conforme o contrato visual.
- **Depends on:** none
- **Cross-cut tag:** `T8-git-summary`

### Layer 2 — tally

| Status | Count |
|---|---|
| accepted | 6 |
| rejected | 0 |
| deferred | 0 |
| withdrawn | 0 |

Cross-cutting tags introduced: `T6-input-normalization`, `T7-layout-safety`, `T8-git-summary`.
Cross-cutting tags reused: `T2-async-freshness` (L2-02, L2-03), `T6-input-normalization` (L2-04).

Dependency edges within Layer 2:

- L2-02 depends on L0-04 (provider generation must exist before body tasks are accepted).
- L2-03 depends on L2-02 (the async usage path should share timeout/cancellation semantics).

---

## Layer 3 — Superfícies principais

Files: `extensions/fusion/footer.ts`, `extensions/fusion/editor.ts`

### L3-01 — Footer excede a largura em terminais extremos

**Evidence**

`extensions/fusion/footer.ts:138-142, 166-190` — `inner` é `width - 2`, mas cada linha recebe padding externo fixo.

**Current state**

Em widths 1–2, o resultado tem mais colunas visíveis que o terminal; o wrapping físico pode quebrar o bookkeeping do differ e deslocar o cursor.

**Desired state**

Cada linha retornada pelo footer deve caber exatamente na largura recebida, inclusive no fallback mais estreito.

**Proposed improvement**

Calcular padding condicional e aplicar uma etapa final de `truncateToWidth`/padding por linha, tratando widths extremos como modo compacto.

- **Severity:** High
- **Effort:** S
- **Blast radius:** internal
- **Class:** polish
- **Status:** **accepted** — garantir largura total em todas as linhas.
- **Depends on:** L2-05
- **Cross-cut tag:** `T7-layout-safety`

### L3-02 — Altura do footer contradiz o contrato dos modos

**Evidence**

`extensions/fusion/footer.ts:162-170, 181-190` — `minimal` inclui `goalLine` e `full` pode retornar três linhas.

**Current state**

A publicação/atualização de um status externo muda a altura do footer durante a sessão, embora `minimal` seja descrito como sempre uma linha. Essa mudança também altera a altura total do frame.

**Desired state**

Cada modo deve ter uma política de altura explícita e previsível, sem inserir linhas surpresa em integrações externas.

**Proposed improvement**

Manter `minimal` em uma linha (compactar/truncar goal) e limitar a altura de `full` a duas linhas, ou formalizar uma reserva estável de linhas por modo e cobrir transições.

- **Severity:** High
- **Effort:** M
- **Blast radius:** cross-module
- **Class:** redesign
- **Status:** **accepted** — honrar o contrato de altura documentado.
- **Depends on:** L0-01, L3-03
- **Cross-cut tag:** `T1-render-synchronization`

### L3-03 — Status externo pode inserir linhas/controles físicos

**Evidence**

`extensions/fusion/footer.ts:147-153, 163` — valores de `getExtensionStatuses()` são concatenados diretamente e passados a `justify`.

**Current state**

Quebras de linha, tabs ou escapes de uma extensão podem produzir mais linhas físicas que strings lógicas, executar controles no terminal ou corromper a próxima pintura.

**Desired state**

O footer deve tratar status de extensões como entrada não confiável e emitir somente uma linha segura, limitada à largura.

**Proposed improvement**

Normalizar whitespace/controles, medir largura visível e truncar cada status antes de compor as linhas do footer.

- **Severity:** High
- **Effort:** S
- **Blast radius:** cross-module
- **Class:** polish
- **Status:** **accepted** — sanitizar e truncar status externos.
- **Depends on:** L2-05
- **Cross-cut tag:** `T6-input-normalization`

### L3-04 — Fallback estreito do editor muda a altura

**Evidence**

`extensions/fusion/editor.ts:199-207` — widths <= 8 ou base curta retornam `super.render()` sem status/meta.

**Current state**

Resize ou layout estreito troca abruptamente do editor com prelude fixo para o editor nativo, reintroduzindo variação de altura e risco de linhas stale no differ.

**Desired state**

O fallback deve conservar a política de altura ou aplicar uma transição explícita e segura para o modo compacto.

**Proposed improvement**

Renderizar um fallback próprio que mantenha as linhas reservadas e reduza conteúdo/bordas de forma determinística, com testes de resize.

- **Severity:** High
- **Effort:** M
- **Blast radius:** internal
- **Class:** redesign
- **Status:** **accepted** — preservar altura constante no fallback estreito.
- **Depends on:** none
- **Cross-cut tag:** `T7-layout-safety`

### L3-05 — Prelude fixo reduz a viewport efetiva do cursor

**Evidence**

`extensions/fusion/editor.ts:157-196, 245-247` — status/meta ocupam duas linhas, mas o editor base calcula linhas visíveis sem conhecer esse custo.

**Current state**

Em terminais baixos ou com texto multilinha/autocomplete, a caixa pode permanecer visível enquanto a linha do cursor/dropdown fica acima da viewport ou é cortada.

**Desired state**

O cálculo de viewport deve reservar explicitamente as linhas adicionais, mantendo cursor e affordances interativas visíveis.

**Proposed improvement**

Integrar a altura do prelude ao layout/scroll do editor, reduzir conteúdo visível quando necessário e testar `LINES` baixos com colagem multilinha.

- **Severity:** Med
- **Effort:** M
- **Blast radius:** cross-module
- **Class:** redesign
- **Status:** **accepted** — integrar a altura extra ao cálculo de layout.
- **Depends on:** L3-04
- **Cross-cut tag:** `T7-layout-safety`

### L3-06 — Resync depende de internals não versionados do pi-tui

**Evidence**

`extensions/fusion/footer.ts:86-111` — cast para campos privados do TUI e escrita manual de ANSI/bookkeeping.

**Current state**

Uma alteração ou ausência desses campos pode causar resync incompleto, cursor em linha errada ou corrupção silenciosa, sem capability check/fallback.

**Desired state**

A recuperação deve verificar a capacidade disponível e degradar para a API pública segura quando a implementação não corresponder ao contrato esperado.

**Proposed improvement**

Encapsular o acesso em um adapter com guards de tipo/versão, validar dimensões e usar `requestRender(true)` como fallback.

- **Severity:** Med
- **Effort:** M
- **Blast radius:** cross-module
- **Class:** redesign
- **Status:** **accepted** — adicionar capability check e fallback público.
- **Depends on:** L0-01
- **Cross-cut tag:** `T3-lifecycle-ownership`

### Layer 3 — tally

| Status | Count |
|---|---|
| accepted | 6 |
| rejected | 0 |
| deferred | 0 |
| withdrawn | 0 |

Cross-cutting tags introduced: `T7-layout-safety`.
Cross-cutting tags reused: `T1-render-synchronization` (L3-02), `T6-input-normalization` (L3-03), `T7-layout-safety` (L3-01, L3-04, L3-05), `T3-lifecycle-ownership` (L3-06).

Dependency edges within Layer 3:

- L3-01 and L3-03 depend on L2-05 (safe width helpers).
- L3-02 depends on L0-01 and L3-03 (stable frame timing and safe external status).
- L3-05 depends on L3-04 (the compact fallback establishes the height contract).
- L3-06 depends on L0-01 (redraw decision should use the guarded recovery path).

---

## Layer 4 — Skin de transcript, patches e notificações

Files: `extensions/fusion/droid.ts`, `extensions/fusion/sound.ts`

### L4-01 — Skin total suprime renderers externos por decisão explícita

**Evidence**

`extensions/fusion/droid.ts:813-845` — renderers sem o símbolo Fusion são convertidos para fallback genérico.

**Current state**

Renderers próprios de outras extensões/MCP deixam de aparecer, mesmo quando a ferramenta continua executando; isso diverge da expectativa de preservação descrita inicialmente na documentação.

**Desired state**

A política de skin deve ser explícita: substituir todos os cards é aceitável se a documentação e a configuração assumirem essa decisão.

**Proposed improvement**

Manter a skin total deliberada e alinhar README/avisos de compatibilidade; não tratar o comportamento como bug de fallback.

- **Severity:** Low
- **Effort:** S
- **Blast radius:** cross-module
- **Class:** polish
- **Status:** **rejected** — decisão do produto é manter a skin total; apenas documentar a precedência se necessário.
- **Depends on:** none
- **Cross-cut tag:** `T9-extension-interoperability`

### L4-02 — Texto de tools pode criar linhas/controles físicos

**Evidence**

`extensions/fusion/droid.ts:209-229, 350-355, 412-416, 516, 793` — labels e conteúdo são inseridos em strings de linha e truncados sem sanitização de newline/controles.

**Current state**

Patterns com quebras e outputs com carriage return/ANSI de cursor podem criar linhas físicas extras, mover o cursor ou deixar o frame lógico divergente do terminal.

**Desired state**

Cada componente deve retornar linhas físicas seguras, com controles permitidos explicitamente e largura visível respeitada.

**Proposed improvement**

Normalizar/dividir texto por linha, neutralizar sequências de cursor/controle, preservar apenas SGR/OSC aprovados e truncar cada linha depois da composição.

- **Severity:** High
- **Effort:** M
- **Blast radius:** internal
- **Class:** redesign
- **Status:** **accepted** — sanitizar texto de tools por linha.
- **Depends on:** L2-05
- **Cross-cut tag:** `T6-input-normalization`

### L4-03 — Cards de tools desaparecem em largura estreita

**Evidence**

`extensions/fusion/droid.ts:350-354` — `lineComponent()` retorna `[]` quando `width <= 8`.

**Current state**

Como o shell também é forçado para `self`, o usuário recebe nenhum cabeçalho/resumo de tool em terminais estreitos, dificultando saber se uma operação ocorreu.

**Desired state**

Mesmo no modo compacto, uma chamada e seu resultado devem fornecer feedback mínimo sem quebrar a linha.

**Proposed improvement**

Criar fallback de uma linha com nome/summary truncados e preservar o estado de erro, em vez de retornar vazio.

- **Severity:** Med
- **Effort:** S
- **Blast radius:** internal
- **Class:** polish
- **Status:** **accepted** — adicionar fallback compacto.
- **Depends on:** none
- **Cross-cut tag:** `T7-layout-safety`

### L4-04 — Wrappers de mensagens excedem widths pequenos

**Evidence**

`extensions/fusion/droid.ts:896-905, 968-982` — marcador fixo e gutter/padding são adicionados após renderizar conteúdo reduzido.

**Current state**

Interrupções, erros ou prompts de usuário podem ultrapassar a largura recebida e embrulhar fisicamente, deslocando o differ.

**Desired state**

Toda linha produzida pelos patches de assistant/user deve caber na largura, com OSC e cores preservados apenas quando houver espaço seguro.

**Proposed improvement**

Aplicar truncamento visível final aos marcadores, notices e linhas do gutter, e testar widths 1–8 com OSC 133 ativo.

- **Severity:** High
- **Effort:** M
- **Blast radius:** internal
- **Class:** polish
- **Status:** **accepted** — truncar wrappers antes de devolver as linhas.
- **Depends on:** L2-05
- **Cross-cut tag:** `T7-layout-safety`

### L4-05 — Unpatch pode sobrescrever alterações posteriores

**Evidence**

`extensions/fusion/droid.ts:813-860, 871-927, 951-991` — cada cleanup restaura a função original sem confirmar que o protótipo ainda contém o wrapper Fusion.

**Current state**

Uma extensão que aplicar um patch depois do Fusion perde sua alteração quando a sessão encerra, podendo quebrar renderers de ferramentas, assistant ou user.

**Desired state**

O teardown deve ser cooperativo e só desfazer o wrapper que ainda é proprietário do slot.

**Proposed improvement**

Guardar as funções wrapper instaladas e comparar por identidade antes de restaurar; se houver outro wrapper, preservar o estado e apenas limpar referências internas.

- **Severity:** High
- **Effort:** M
- **Blast radius:** cross-module
- **Class:** redesign
- **Status:** **accepted** — restaurar com ownership guard.
- **Depends on:** L0-05
- **Cross-cut tag:** `T3-lifecycle-ownership`

### L4-06 — Cache de tool IDs cresce sem limite

**Evidence**

`extensions/fusion/droid.ts:324-342` — `doneIds` recebe todo ID finalizado e não possui limpeza por sessão/tempo.

**Current state**

Sessões longas acumulam um Set proporcional ao número total de tools, mesmo quando os componentes já não dependem do latch.

**Desired state**

O estado de shimmer deve durar somente enquanto necessário para a sessão/transcript ativo, com limite de memória previsível.

**Proposed improvement**

Limpar o Set no lifecycle da sessão ou aplicar TTL/LRU coordenado com cards restaurados, sem reanimar componentes ainda visíveis.

- **Severity:** Med
- **Effort:** S
- **Blast radius:** internal
- **Class:** polish
- **Status:** **accepted** — limpar por sessão/TTL.
- **Depends on:** none
- **Cross-cut tag:** `T10-resource-lifecycle`

### L4-07 — Expansão de output não tem teto vertical geral

**Evidence**

`extensions/fusion/droid.ts:475-520, 740-795` — modo expandido adiciona uma linha por output/diff sem limite comum.

**Current state**

Um comando ou diff muito grande aumenta o frame inteiro, torna cada repaint caro e pode causar overflow/scrollback corruption justamente durante o shimmer.

**Desired state**

Expansão deve ser útil sem bloquear input nem permitir que um card monopolize o frame.

**Proposed improvement**

Aplicar teto por card, paginação/continuação explícita e resumo de linhas ocultas; preservar expansão incremental para o usuário.

- **Severity:** High
- **Effort:** M
- **Blast radius:** internal
- **Class:** redesign
- **Status:** **accepted** — limitar e paginar conteúdo expandido.
- **Depends on:** L4-02
- **Cross-cut tag:** `T7-layout-safety`

### L4-08 — Playback pode duplicar fallback e sobreviver ao teardown

**Evidence**

`extensions/fusion/sound.ts:103-128` — callback de `execFile` e listener `error` podem chamar bell/resolve; child não é registrado para cancelamento.

**Current state**

Uma falha pode emitir dois BELs e um processo de áudio pode terminar depois da sessão, gerando notificações fora de contexto.

**Desired state**

Cada reprodução deve resolver uma vez e estar vinculada ao lifecycle da extensão.

**Proposed improvement**

Usar settle idempotente, registry de children e cancelamento no shutdown; manter fallback único e observável.

- **Severity:** Med
- **Effort:** M
- **Blast radius:** internal
- **Class:** redesign
- **Status:** **accepted** — garantir idempotência e cancelamento.
- **Depends on:** L0-05
- **Cross-cut tag:** `T10-resource-lifecycle`

### L4-09 — Cores forçam truecolor sem capability check

**Evidence**

`extensions/fusion/droid.ts:173-180, 937-942` — `hex` e `bg` emitem sempre SGR truecolor.

**Current state**

Em terminais 256/16-color ou sessões SSH, a paleta pode degradar de forma inconsistente ou gerar escapes não suportados.

**Desired state**

A skin deve respeitar a capacidade declarada pelo TUI/terminal e degradar previsivelmente.

**Proposed improvement**

Encapsular cor em um resolver que escolha truecolor/256/16/default conforme capability, mantendo fallback da paleta.

- **Severity:** Low
- **Effort:** M
- **Blast radius:** internal
- **Class:** redesign
- **Status:** **accepted** — usar capability de cor antes de emitir ANSI.
- **Depends on:** none
- **Cross-cut tag:** `T11-terminal-capabilities`

### L4-10 — Shimmer quebra graphemes Unicode

**Evidence**

`extensions/fusion/droid.ts:299-312` — iteração por unidade UTF-16 e comprimento bruto.

**Current state**

Emoji/surrogate pairs podem aparecer separados por escapes e renderizar como caracteres substitutos; CJK também pode deslocar a onda/alinhamento.

**Desired state**

A animação deve tratar grapheme clusters e largura visual, mantendo cada símbolo intacto.

**Proposed improvement**

Usar `Intl.Segmenter`/segmentação equivalente e `visibleWidth` para indexar clusters, com fallback seguro para runtimes sem Segmenter.

- **Severity:** Low
- **Effort:** M
- **Blast radius:** internal
- **Class:** polish
- **Status:** **accepted** — iterar graphemes e largura visível.
- **Depends on:** L4-02
- **Cross-cut tag:** `T11-terminal-capabilities`

### L4-11 — Probe de player bloqueia o event loop

**Evidence**

`extensions/fusion/sound.ts:53-79` — cada escolha de player Linux executa `spawnSync`.

**Current state**

Notificações frequentes podem bloquear entrada/render ao sondar PATH repetidamente, especialmente em ambientes lentos ou com PATH remoto.

**Desired state**

A descoberta do player deve ser feita uma vez ou fora do caminho crítico de renderização.

**Proposed improvement**

Cachear o player por plataforma e fazer descoberta assíncrona/na inicialização, com fallback não bloqueante.

- **Severity:** Med
- **Effort:** M
- **Blast radius:** internal
- **Class:** polish
- **Status:** **accepted** — cachear e/ou tornar assíncrona a descoberta.
- **Depends on:** L4-08
- **Cross-cut tag:** `T10-resource-lifecycle`

### Layer 4 — tally

| Status | Count |
|---|---|
| accepted | 10 |
| rejected | 1 |
| deferred | 0 |
| withdrawn | 0 |

Cross-cutting tags introduced: `T9-extension-interoperability`, `T10-resource-lifecycle`.
Cross-cutting tags reused: `T3-lifecycle-ownership` (L4-05), `T6-input-normalization` (L4-02), `T7-layout-safety` (L4-03, L4-04, L4-07), `T10-resource-lifecycle` (L4-08, L4-11).

Dependency edges within Layer 4:

- L4-02 and L4-04 depend on L2-05 (safe line-width primitives).
- L4-05 depends on L0-05 (shared ownership policy).
- L4-07 depends on L4-02 (sanitize line boundaries before pagination).
- L4-08 depends on L0-05 (lifecycle ownership/teardown coordination).
- L4-10 depends on L4-02 (shared text sanitization/segmentation boundary).
- L4-11 depends on L4-08 (shared sound process lifecycle).

---

## Cross-cutting themes

### T1 — Render synchronization (active)

**Findings:** L0-01, L0-02, L3-02.

Esses achados tratam do momento em que mudanças de estado/altura entram no frame e de como o differ decide entre resync e scrub. O tema entrega decisões de redraw baseadas no frame efetivo e uma política de altura estável para que mudanças de goal/status não sejam gravadas como linhas stale.

### T2 — Async freshness (active)

**Findings:** L0-03, L0-04, L2-02, L2-03.

Git e usage atravessam rede/subprocessos e podem concluir fora de ordem ou depois do teardown. A linha de trabalho é geração/cancelamento, timeout do body e lookup não bloqueante, evitando que dados antigos repintem o footer ou congelem a TUI.

### T3 — Lifecycle ownership (active)

**Findings:** L0-05, L0-07, L3-06, L4-05.

Superfícies, input de foco, resync e patches globais precisam de ownership/capability explícitos. O tema fecha com teardown cooperativo e fallback seguro quando o terminal ou o pi-tui não oferecem os internals esperados.

### T4 — State/render coherence (active)

**Findings:** L0-06, L1-03.

A atividade do agente e o label visual devem derivar de uma fonte coerente, priorizando asks pendentes e evitando combinações como border idle com texto de trabalho.

### T5 — Config integrity (active)

**Findings:** L1-01, L1-02.

A configuração persistida precisa rejeitar valores inválidos e sobreviver a concorrência/interrupção. Validação e escrita atômica impedem que o próximo startup reintroduza estado impossível.

### T6 — Input normalization (active)

**Findings:** L2-01, L2-04, L3-03, L4-02.

Paths, payloads externos, status de extensões e outputs de tools entram no frame por caminhos diferentes, mas todos exigem normalização antes de `visibleWidth`, truncamento e composição.

### T7 — Layout safety (active)

**Findings:** L2-05, L3-01, L3-04, L3-05, L4-03, L4-04, L4-07.

Este é o maior fio de renderização: largura, altura, fallback estreito, cursor e expansão precisam ser limites rígidos. O tema reduz wrapping físico, frames gigantes e perda de feedback em terminais pequenos.

### T8 — Git summary (active)

**Findings:** L2-06.

O parser e o resumo visual devem falar a mesma linguagem sobre estados de arquivo. Contadores completos evitam que o usuário veja um dirty marker sem a mudança correspondente no detalhe.

### T9 — Extension interoperability (closed by L4-01)

**Findings:** L4-01.

A divergência sobre renderers externos foi deliberadamente rejeitada: a skin total é uma decisão de produto. O fechamento exige somente que a precedência seja documentada, não uma alteração de runtime.

### T10 — Resource lifecycle (active)

**Findings:** L4-06, L4-08, L4-11.

Shimmer IDs, children de áudio e probes de player devem ter duração limitada e não bloquear/emitir efeitos após a sessão. Registry, TTL, settle idempotente e cache reduzem vazamento e trabalho repetido.

### T11 — Terminal capabilities (active)

**Findings:** L4-09, L4-10.

A skin precisa respeitar tanto a capacidade de cor quanto a unidade visual de Unicode. Resolver truecolor/256-color e animar graphemes evita degradação e desalinhamento em ambientes reais.


---

## Consolidated polish plan

7 fases, ordenadas por dependências e por risco de frame.

### Phase 1 — Primitivas seguras de boundary

**Goal:** Tornar parsers/formatters/helpers totais e normalizar dados antes de chegar às superfícies.

**Findings (5):** L1-01, L2-01, L2-04, L2-05, L2-06.

**Files touched (4):** `extensions/fusion/config.ts`, `extensions/fusion/format.ts`, `extensions/fusion/theme.ts`, `extensions/fusion/git.ts`.

**Blast-radius mix:** internal: 5; public-API: 0; on-disk: 0; cross-module: 0.

**Class mix:** polish: 5; redesign: 0.

**Coordination:** none.

**Risk callouts:** Alterações em `formatCwd` e parser Git mudam texto/contadores observáveis; preservar casos de home, detached e estados XY.

### Phase 2 — Contratos de configuração e atividade

**Goal:** Persistir configuração de forma íntegra e derivar uma view única para atividade/label.

**Findings (3):** L1-02, L1-03, L0-06.

**Files touched (3):** `extensions/fusion/config.ts`, `extensions/fusion/state.ts`, `extensions/fusion/index.ts`.

**Blast-radius mix:** internal: 2; public-API: 0; on-disk: 1; cross-module: 0.

**Class mix:** polish: 1; redesign: 2.

**Coordination:** none.

**Risk callouts:** A escrita atômica deve preservar chaves desconhecidas; a nova view precisa manter a prioridade de asks e não alterar o contrato de `FusionState` sem ajustar editor/footer.

### Phase 3 — Frescor assíncrono e responsividade

**Goal:** Impedir respostas antigas e operações bloqueantes de repintarem/congelarem o TUI.

**Findings (4):** L0-03, L0-04, L2-02, L2-03.

**Files touched (2):** `extensions/fusion/index.ts`, `extensions/fusion/usage.ts`.

**Blast-radius mix:** internal: 4; public-API: 0; on-disk: 0; cross-module: 0.

**Class mix:** polish: 0; redesign: 4.

**Coordination:** none.

**Risk callouts:** Provider generations, AbortSignal e timers precisam compartilhar a mesma política; a primeira pintura não pode aguardar keychain/fetch.

### Phase 4 — Geometria do frame e recuperação

**Goal:** Garantir largura/altura previsíveis do footer/editor e escolher resync/scrub usando dados válidos.

**Findings (6):** L0-01, L0-02, L3-01, L3-04, L3-05, L3-06.

**Files touched (3):** `extensions/fusion/index.ts`, `extensions/fusion/footer.ts`, `extensions/fusion/editor.ts`.

**Blast-radius mix:** internal: 4; public-API: 0; on-disk: 0; cross-module: 2.

**Class mix:** polish: 1; redesign: 5.

**Coordination:** none.

**Risk callouts:** Toca internals do pi-tui e o cálculo de viewport; validar em resize, `LINES` baixo, composição ativa e frames que passam da viewport antes de ajustar o differ.

### Phase 5 — Texto seguro e limites de transcript

**Goal:** Fazer footer/transcript retornarem linhas físicas seguras, com fallback estreito e expansão paginada.

**Findings (7):** L3-03, L3-02, L4-02, L4-03, L4-04, L4-07, L4-10.

**Files touched (2):** `extensions/fusion/footer.ts`, `extensions/fusion/droid.ts`.

**Blast-radius mix:** internal: 5; public-API: 0; on-disk: 0; cross-module: 2.

**Class mix:** polish: 4; redesign: 3.

**Coordination:** none.

**Risk callouts:** Sanitização deve preservar SGR/OSC 133 necessários; limitar output não pode esconder erros ou remover o resumo de expansão; `minimal` precisa continuar one-line.

### Phase 6 — Ownership e teardown de recursos

**Goal:** Tornar patches, listeners, timers, shimmer IDs e processos de áudio cooperativos e bounded.

**Findings (6):** L0-05, L0-07, L4-05, L4-06, L4-08, L4-11.

**Files touched (3):** `extensions/fusion/index.ts`, `extensions/fusion/droid.ts`, `extensions/fusion/sound.ts`.

**Blast-radius mix:** internal: 4; public-API: 0; on-disk: 0; cross-module: 2.

**Class mix:** polish: 2; redesign: 4.

**Coordination:** none.

**Risk callouts:** Cleanup não pode restaurar patches posteriores nem remover componentes de terceiros; reproduções de som devem ter settle único e terminar no shutdown.

### Phase 7 — Capabilities de terminal

**Goal:** Degradar cores e animações de forma previsível em terminais sem truecolor e com Unicode de largura variável.

**Findings (1):** L4-09.

**Files touched (1):** `extensions/fusion/droid.ts`.

**Blast-radius mix:** internal: 1; public-API: 0; on-disk: 0; cross-module: 0.

**Class mix:** polish: 0; redesign: 1.

**Coordination:** none.

**Risk callouts:** O resolver de cor deve manter a paleta atual em truecolor e não alterar a largura visível dos cards; L4-10 já está na Phase 5 por depender da sanitização/limites de texto.

### Dependency graph (phase-level)

```
Phase 1 (Primitivas seguras)
   ↓
Phase 2 (Configuração e atividade)
   ↓
Phase 3 (Frescor assíncrono)
   ↓
Phase 4 (Geometria e recuperação)
   ↓
Phase 5 (Texto e transcript)
   ↓
Phase 6 (Ownership e teardown)
   ↓
Phase 7 (Capabilities de terminal)
```

### Phase scope summary

| Phase | Findings | Files | Blast-radius mix | Coordination |
|---|---:|---:|---|---|
| 1 — Primitivas seguras | 5 | 4 | internal: 5 | none |
| 2 — Configuração e atividade | 3 | 3 | internal: 2; on-disk: 1 | none |
| 3 — Frescor assíncrono | 4 | 2 | internal: 4 | none |
| 4 — Geometria e recuperação | 6 | 3 | internal: 4; cross-module: 2 | none |
| 5 — Texto e transcript | 7 | 2 | internal: 5; cross-module: 2 | none |
| 6 — Ownership e teardown | 6 | 3 | internal: 4; cross-module: 2 | none |
| 7 — Capabilities de terminal | 1 | 1 | internal: 1 | none |
| **Total** | **32** | **11 (com sobreposição)** | — | — |

### Risk callouts (cross-phase)

1. Phase 1 deve aterrissar antes de qualquer correção de largura/texto; `renderBar` e normalização são primitivas compartilhadas.
2. Phase 2 muda estado e persistência; validar compatibilidade dos campos antes de alterar handlers na Phase 3/4.
3. Phase 4 e Phase 5 tocam simultaneamente a altura do frame; landear a política de geometria antes de paginação/sanitização do transcript.
4. Phase 6 deve ser testada com outra extensão instalada para confirmar ownership; nenhum cleanup deve assumir exclusividade.
5. O finding L4-01 foi rejeitado e não entra nas fases: skin total permanece intencional.

### Final tally

| Layer | Findings | Accepted | Withdrawn |
|---|---:|---:|---:|
| L0 — Entrada e integração | 7 | 7 | 0 |
| L1 — Estado e configuração | 3 | 3 | 0 |
| L2 — Dados, formatação e tema | 6 | 6 | 0 |
| L3 — Superfícies principais | 6 | 6 | 0 |
| L4 — Skin, patches e notificações | 11 | 10 | 0 |
| **Total** | **33** | **32** | **0** |

**Cross-cuts closed by completion of this plan:** `T9-extension-interoperability` (1 de 11; decisão deliberada de manter a skin total).

**Cross-cuts remaining active (by design, post-completion):** `T1`, `T2`, `T3`, `T4`, `T5`, `T6`, `T7`, `T8`, `T10`, `T11` — cada um representa trabalho aceito nas fases acima.

