# 05 — UX, responsividade e acessibilidade

## 1. Objetivo

Tornar os rails descobríveis e utilizáveis sem sacrificar densidade, espaço de
conversa ou operação por teclado.

## 2. Geometria

### Desktop amplo

- Navigator: padrão 300 px, mínimo 240 px, máximo 420 px.
- Activity rail: 44 px.
- Dock padrão: 360 px, mínimo 300 px, máximo 45% da área.
- Canvas: preferência wide, de 42% a 72% quando houver espaço.
- Conversation preserva mínimo funcional definido por teste visual.

### Desktop estreito / mounts compactos

- Navigator pode colapsar para drawer.
- Dock abre como overlay ancorado à direita.
- Activity rail continua disponível ou é substituído por trigger rotulado.
- Nenhum destino depende de breakpoint `lg` para existir.

### Mobile

- Cabeçalho oferece “Sessões” e “Ferramentas da sessão”.
- Ambos abrem sheets full-height com foco contido e restauração de foco.
- Canvas pode ocupar rota/sheet própria.

- **CSW-UX-001** — Nenhum resize pode produzir horizontal scroll nos rails.
- **CSW-UX-002** — Resize handle tem target mínimo e suporte a teclado.
- **CSW-UX-003** — Dimensões persistidas são scoped por superfície/projeto.

## 3. Activity rail

- Destino ativo tem indicador, contraste e label no header do dock.
- Inativos revelam label em hover/foco sem expandir o layout horizontal.
- Tooltip não é o único mecanismo para o estado ativo.
- Separação visual: primários, dinâmicos/plugins e configuração.
- Badge usa texto acessível e não depende somente de cor.
- Settings fica no rodapé sem tornar destinos intermediários inalcançáveis.

- **CSW-UX-004** — Ordem visual e ordem de tab são idênticas.
- **CSW-UX-005** — Arrow keys navegam entre destinos; Enter/Space ativa.
- **CSW-UX-006** — Escape fecha overlay/dock quando apropriado.
- **CSW-UX-007** — Rail anuncia `aria-label`, destino e estado expandido.

## 4. Navigator de sessões

- Busca persistente no topo.
- Filtros numa ação única com resumo dos ativos.
- Toolbar mantém somente ações frequentes; destrutivas ficam em menu/command
  bar contextual.
- Linhas mostram título, status/run, provider/model e recência com hierarquia.
- Tokens ficam em detalhe/tooltip quando falta espaço; não competem com status.
- Ações de hover também aparecem por `focus-within`.
- Seleção múltipla tem checkbox real e command bar com resultado parcial.

- **CSW-UX-008** — Linha virtualizada continua focável e selecionável.
- **CSW-UX-009** — Busca retorna empty state acionável e permite limpar filtros.
- **CSW-UX-010** — Sessão ativa nunca é indicada apenas por um pixel colorido.

## 5. Dock e painéis

Chrome comum contém:

- ícone e título;
- status/subtitle opcional;
- ações contextuais;
- tabs quando existirem;
- close;
- regiões padronizadas de loading, stale, error e empty.

O conteúdo tem um único owner de scroll. Painel não pode criar scroll aninhado
sem necessidade funcional, como preview, code block ou JSON expandido.

## 6. Worker Log alvo

Layout:

1. cabeçalho com estado live/paused e export;
2. resumo compacto de total, warnings e errors;
3. busca e botão de filtros;
4. timeline virtualizada;
5. detalhe expansível com JSON formatado, copiar e vínculo à operação;
6. âncora “voltar ao live” quando o usuário se afastar do fim.

- Chips de todas as categorias não ocupam uma linha permanente.
- Empty state distingue “sem execução”, “histórico carregando” e “filtros sem
  resultado”.
- Eventos truncados indicam tamanho original e motivo.

## 7. Internacionalização

- **CSW-I18N-001** — Todo texto visível e label acessível usa namespace i18n.
- **CSW-I18N-002** — Pluralização de events, sessions e badges usa i18next.
- **CSW-I18N-003** — Datas e números usam locale ativo.
- **CSW-I18N-004** — PT-BR e EN possuem paridade validada por teste.

## 8. Acessibilidade

- WCAG 2.2 AA como alvo.
- Contraste de active, badge, warning e focus ring validado.
- Foco não é perdido em lazy load, troca de sessão ou fechamento de sheet.
- Virtualização expõe posição/tamanho quando necessário.
- Reduced motion desativa transições não essenciais.
- Leitores de tela recebem anúncios para comando concluído, erro parcial,
  reconnect e novo warning crítico.

