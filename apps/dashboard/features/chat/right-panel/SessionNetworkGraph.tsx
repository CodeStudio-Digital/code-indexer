import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { NetworkData } from './network-types.js';

export function SessionNetworkGraph({ data }: { data: NetworkData }) {
  const { t } = useTranslation('chat');
  const marker = useId().replace(/:/g, '');
  const [selected, setSelected] = useState(data.self);
  const team = data.companyTeam;
  const teamNodes = [...(team?.members ?? [])].sort((a, b) => Number(b.id === team?.masterId) - Number(a.id === team?.masterId))
    .map(member => ({ id: `chat:${member.id}`, sessionId: member.id, label: member.role === 'master' ? 'Master' : member.role, state: member.state }));
  const teamIds = new Set(teamNodes.map(node => node.id));
  const peers = [{ id: data.self, sessionId: data.self.replace(/^chat:/, ''), label: t('collaboration.thisChat'), state: 'coordinator' }, ...data.peers].slice(0, 33);
  const nodes = [...teamNodes, ...peers.filter(node => !teamIds.has(node.id))];
  const positions = new Map(nodes.map((node, index) => [node.id, { x: index === 0 ? 180 : (index % 2 ? 92 : 268), y: index === 0 ? 35 : 115 + Math.floor((index - 1) / 2) * 94 }]));
  const edges = [
    ...teamNodes.slice(1).map(node => ({ from: teamNodes[0].id, to: node.id, kind: 'company' })),
    ...data.links.slice(0, 60).map(link => ({ from: `chat:${link.sessions[0]}`, to: `chat:${link.sessions[1]}`, kind: 'link' })),
    ...data.messages.slice(0, 20).map(message => ({ from: message.from, to: message.to, kind: 'message' })),
    ...data.triggers.filter(trigger => trigger.status === 'waiting').map(trigger => ({ from: `chat:${trigger.sourceSessionId}`, to: `chat:${trigger.targetSessionId}`, kind: 'trigger' })),
  ];
  const peer = nodes.find(node => node.id === selected);
  const chat = team?.members.find(member => member.id === peer?.sessionId) ?? data.chats.find(chat => chat.id === peer?.sessionId);
  return <section className="space-y-2" aria-label={t('network.graph')}>
    <div className="max-h-80 overflow-auto rounded border bg-muted/15">
      <svg viewBox={`0 0 360 ${Math.max(180, 115 + Math.ceil((nodes.length - 1) / 2) * 94)}`} className="w-full min-w-[300px]" role="img" aria-label={t('network.graph')}>
        <defs><marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" /></marker></defs>
        {edges.map((edge, index) => { const from = positions.get(edge.from), to = positions.get(edge.to); return from && to && <path key={index}
          d={`M ${from.x} ${from.y} Q ${(from.x + to.x) / 2 + 25} ${(from.y + to.y) / 2} ${to.x} ${to.y - 22}`}
          fill="none" stroke={edge.kind === 'trigger' ? '#f59e0b' : edge.kind === 'message' ? '#8b5cf6' : edge.kind === 'company' ? '#7c83ac' : 'currentColor'}
          className={edge.kind === 'link' ? 'text-muted-foreground/25' : ''} strokeWidth={edge.kind === 'link' ? 1 : 2}
          strokeDasharray={edge.kind === 'trigger' ? '5 3' : undefined} markerEnd={edge.kind !== 'link' ? `url(#${marker})` : undefined} />; })}
        {nodes.map(node => { const pos = positions.get(node.id)!; return <g key={node.id} role="button" tabIndex={0}
          aria-label={node.label} onClick={() => setSelected(node.id)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelected(node.id); } }} className="cursor-pointer">
          <rect x={pos.x - 77} y={pos.y - 25} width="154" height="50" rx="8" fill="var(--background)" stroke={selected === node.id ? '#8b5cf6' : 'currentColor'} className="text-border" strokeWidth="2" />
          <circle cx={pos.x - 65} cy={pos.y - 6} r="3" fill={['running', 'working'].includes(node.state) ? '#22c55e' : ['error', 'aborted', 'stopped'].includes(node.state) ? '#ef4444' : node.state === 'interrupted' ? '#f59e0b' : '#94a3b8'} />
          <title>{node.label}</title>
          <text x={pos.x - 55} y={pos.y - 3} fontSize="12" fill="currentColor">{node.label.length > 19 ? node.label.slice(0, 18) + '…' : node.label}</text>
          <text x={pos.x} y={pos.y + 14} textAnchor="middle" fontSize="11" className="fill-muted-foreground">{t(`collaboration.state.${node.state}`, node.state)}</text>
        </g>; })}
      </svg>
    </div>
    <p className="text-[10px] text-muted-foreground">{t('network.graphLegend')}{team && ' · ' + t('network.companyEdge')}</p>
    {chat && <div className="rounded border p-2"><p className="font-medium">{chat.title}</p><p className="break-all text-muted-foreground">{chat.provider} · {chat.model}</p>
      <a className="text-primary hover:underline" href={`#${chat.projectId == null ? '/global' : `/projects/${chat.projectId}`}?session=${encodeURIComponent(chat.id)}`}>{t('network.openChat')}</a>
    </div>}
  </section>;
}
