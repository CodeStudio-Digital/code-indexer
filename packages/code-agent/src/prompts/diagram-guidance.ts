/**
 * Static system-prompt block for the draw.io diagram capability. Appended to
 * the system prompt ONLY when the `diagram` tier is active (the `diagram`
 * agent, or a session that persisted `expand_toolset('diagram')`), so
 * non-diagram sessions never pay the token cost.
 *
 * Teaches the model to author VALID draw.io (mxGraph) XML and to prefer
 * iterative edits over full regeneration. The templates are deliberately tiny
 * (a few cells each) to bound the prompt cost — they show the SHAPE, not a
 * finished diagram. Byte-stable across turns → prompt-cache safe.
 */

/** The accepted XML envelope, shown once so every template can stay terse. */
const ENVELOPE = `<mxfile host="codestudio">
  <diagram name="Page-1">
    <mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" math="0" shadow="0">
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
        <!-- your vertices and edges go here, each with parent="1" -->
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`;

const FLOWCHART = `<mxCell id="start" value="Start" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;" vertex="1" parent="1"><mxGeometry x="40" y="40" width="120" height="50" as="geometry"/></mxCell>
<mxCell id="dec" value="Valid?" style="rhombus;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;" vertex="1" parent="1"><mxGeometry x="60" y="140" width="80" height="60" as="geometry"/></mxCell>
<mxCell id="e1" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;" edge="1" parent="1" source="start" target="dec"><mxGeometry relative="1" as="geometry"/></mxCell>`;

const ARCHITECTURE = `<mxCell id="user" value="User" style="shape=mxgraph.aws4.user;sketch=0;outlineConnect=0;html=1;" vertex="1" parent="1"><mxGeometry x="40" y="40" width="48" height="48" as="geometry"/></mxCell>
<mxCell id="api" value="API Gateway" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1"><mxGeometry x="160" y="40" width="140" height="50" as="geometry"/></mxCell>
<mxCell id="db" value="Postgres" style="shape=cylinder3;whiteSpace=wrap;html=1;fillColor=#f8cecc;strokeColor=#b85450;" vertex="1" parent="1"><mxGeometry x="360" y="36" width="70" height="70" as="geometry"/></mxCell>
<mxCell id="ae1" style="html=1;" edge="1" parent="1" source="user" target="api"><mxGeometry relative="1" as="geometry"/></mxCell>
<mxCell id="ae2" style="html=1;" edge="1" parent="1" source="api" target="db"><mxGeometry relative="1" as="geometry"/></mxCell>`;

const CONTAINER = `<mxCell id="grp" value="Backend (VPC)" style="rounded=1;whiteSpace=wrap;html=1;fillColor=none;strokeColor=#666;verticalAlign=top;dashed=1;" vertex="1" parent="1"><mxGeometry x="40" y="40" width="280" height="160" as="geometry"/></mxCell>
<mxCell id="svc" value="Service" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="grp"><mxGeometry x="40" y="40" width="120" height="50" as="geometry"/></mxCell>`;

const SEQUENCE = `<mxCell id="la" value="Client" style="shape=umlActor;verticalLabelPosition=bottom;html=1;" vertex="1" parent="1"><mxGeometry x="40" y="20" width="30" height="60" as="geometry"/></mxCell>
<mxCell id="ll" value="Server" style="shape=umlLifeline;perimeter=lifelinePerimeter;html=1;" vertex="1" parent="1"><mxGeometry x="200" y="20" width="100" height="220" as="geometry"/></mxCell>
<mxCell id="msg" value="GET /resource" style="html=1;endArrow=block;" edge="1" parent="1" source="la" target="ll"><mxGeometry relative="1" as="geometry"/></mxCell>`;

/** Build the diagram-authoring guidance block. Pure + deterministic. */
export function buildDiagramGuidance(): string {
  return [
    '## Draw.io diagram authoring',
    '',
    'You have the draw.io diagram tier: `diagram_create`, `diagram_update`, `diagram_read`, `diagram_list`, `diagram_export`. Diagrams are real `.drawio` files under `diagrams/` and render live in an embedded editor. Use them to design architecture, flows, and implementations visually.',
    '',
    '### Workflow',
    '- Create a first pass with `diagram_create` (it must NOT already exist — `diagram_list` to check).',
    '- To change a diagram: `diagram_read` it, make MINIMAL edits, then `diagram_update` with the COMPLETE updated XML. Do not regenerate the whole thing from scratch each time.',
    '- `diagram_export` writes an SVG/PNG next to the file (needs the panel open) — use it to embed a diagram in a README/PR.',
    '',
    '### XML format (mxGraph)',
    'Diagrams are mxGraph XML. Always use this envelope (the two implicit cells `id="0"` and `id="1"` are mandatory; every shape/edge sets `parent="1"`):',
    '',
    '```xml',
    ENVELOPE,
    '```',
    '',
    'Rules:',
    '- Vertices: `vertex="1"` + a child `<mxGeometry x y width height as="geometry"/>`. Edges: `edge="1"` + `source`/`target` cell ids + `<mxGeometry relative="1" as="geometry"/>`.',
    '- Lay shapes out on a grid (multiples of 10/20); leave room so edges don\'t overlap. Group related nodes inside a container cell (set the children\'s `parent` to the container id, with geometry RELATIVE to it).',
    '- Escape `&`, `<`, `>` inside `value=`/labels (`&amp;`, `&lt;`, `&gt;`).',
    '- Style is a `key=value;` string. Useful keys: `rounded`, `whiteSpace=wrap;html=1`, `fillColor`, `strokeColor`, `dashed`, `shape=...`.',
    '',
    '### Shape vocabulary by diagram type',
    '- Flowchart: `rounded=1` (process), `rhombus` (decision), `ellipse` (start/end). Orthogonal edges: `edgeStyle=orthogonalEdgeStyle`.',
    '- Cloud/software architecture: AWS `shape=mxgraph.aws4.*`, Azure `shape=mscae/*`, GCP `shape=mxgraph.gcp2.*`; generic `shape=cylinder3` (DB), rounded rects (services). Wrap a tier in a dashed container (VPC/subnet).',
    '- Network: `shape=mxgraph.networks.*` (router/switch/firewall/server).',
    '- ER: `shape=table` with `tableRow`/`partialRectangle` child rows, or labeled rectangles with crow\'s-foot edges (`startArrow=ERmany;endArrow=ERone`).',
    '- Sequence: `shape=umlActor`, `shape=umlLifeline`, message edges `endArrow=block` / `dashed=1` for returns.',
    '- C4: labeled rectangles per Person/System/Container/Component; a dashed container for a boundary; edges labeled with the interaction + protocol.',
    '',
    '### Tiny templates (extend them — don\'t ship them as-is)',
    'Flowchart cells:',
    '```xml',
    FLOWCHART,
    '```',
    'Architecture cells (user → API → DB):',
    '```xml',
    ARCHITECTURE,
    '```',
    'Container/boundary (children use `parent="grp"`):',
    '```xml',
    CONTAINER,
    '```',
    'Sequence cells:',
    '```xml',
    SEQUENCE,
    '```',
    '',
    'If `diagram_create`/`diagram_update` reports invalid XML, read the error, fix that specific issue (usually an unclosed tag, a stray `&`, or a missing implicit cell), and retry.',
  ].join('\n');
}
