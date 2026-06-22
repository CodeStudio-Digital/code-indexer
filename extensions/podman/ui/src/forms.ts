/** Create/run modals (run container, pull image, create volume/network/pod).
 *  A kit-styled overlay over `field()` controls; submit runs the podman tool. */
import { button, div, el, field, input, mutate, textarea } from '@mcp/plugin-sdk/ui';
import type { CreateKind } from './resources.js';
import type { Translate } from './i18n.js';

interface FieldSpec {
  key: string;
  label: string;
  placeholder?: string;
  value?: string;
  area?: boolean;
}

function fieldsModal(
  t: Translate,
  title: string,
  fields: FieldSpec[],
  onSubmit: (values: Record<string, string>) => void,
): void {
  const backdrop = div('pod-backdrop');
  const modal = div('pod-modal');
  modal.appendChild(el('h3', 'pod-modal-title', title));

  const controls = new Map<string, HTMLInputElement | HTMLTextAreaElement>();
  for (const f of fields) {
    const ctrl = f.area ? textarea(f.placeholder, f.value ?? '') : input(f.placeholder);
    if (!f.area && f.value) (ctrl as HTMLInputElement).value = f.value;
    controls.set(f.key, ctrl);
    modal.appendChild(field(f.label, ctrl));
  }

  const close = () => backdrop.remove();
  modal.appendChild(
    div(
      'pod-modal-actions',
      button(t('common.cancel'), 'sm', close),
      button(t('common.run'), 'primary sm', () => {
        const out: Record<string, string> = {};
        for (const [k, c] of controls) out[k] = c.value.trim();
        close();
        onSubmit(out);
      }),
    ),
  );

  backdrop.appendChild(modal);
  backdrop.onclick = (e) => {
    if (e.target === backdrop) close();
  };
  document.body.appendChild(backdrop);
  [...controls.values()][0]?.focus();
}

export function openCreate(
  kind: CreateKind,
  t: Translate,
  reload: () => void,
  presetImage?: string,
): void {
  const done = (tool: string, args: Record<string, unknown>) =>
    void mutate(tool, args).then((r) => {
      if (r) reload();
    });

  switch (kind) {
    case 'run':
      fieldsModal(
        t,
        t('form.run'),
        [
          { key: 'image', label: t('form.image'), value: presetImage ?? '', placeholder: 'docker.io/library/nginx:latest' },
          { key: 'name', label: t('form.nameOpt') },
          { key: 'ports', label: t('form.ports'), placeholder: '8080:80' },
          { key: 'env', label: t('form.env'), area: true },
          { key: 'volumes', label: t('form.volumes'), placeholder: '/host:/app' },
        ],
        (v) => done('podman_run', { image: v.image, name: v.name || undefined, ports: v.ports, env: v.env, volumes: v.volumes }),
      );
      break;
    case 'pull':
      fieldsModal(t, t('form.pull'), [{ key: 'reference', label: t('form.reference'), placeholder: 'docker.io/library/node:20' }], (v) =>
        done('podman_pull', { reference: v.reference }),
      );
      break;
    case 'volume':
      fieldsModal(t, t('form.createVolume'), [{ key: 'name', label: t('col.name') }, { key: 'driver', label: t('form.driverOpt') }], (v) =>
        done('podman_volume_create', { name: v.name, driver: v.driver || undefined }),
      );
      break;
    case 'network':
      fieldsModal(t, t('form.createNetwork'), [{ key: 'name', label: t('col.name') }, { key: 'subnet', label: t('form.subnetOpt') }], (v) =>
        done('podman_network_create', { name: v.name, subnet: v.subnet || undefined }),
      );
      break;
    case 'pod':
      fieldsModal(t, t('form.createPod'), [{ key: 'name', label: t('col.name') }, { key: 'ports', label: t('form.portsList') }], (v) =>
        done('podman_pod_create', { name: v.name, ports: v.ports }),
      );
      break;
  }
}
