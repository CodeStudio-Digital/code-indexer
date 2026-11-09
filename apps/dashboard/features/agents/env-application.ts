export interface EnvApplication {
  state: 'applied' | 'partial' | 'failed' | 'stored';
  applied: string[];
  failed: Array<{ serviceId: string; reason: string }>;
  restartRequired: boolean;
}
export async function readEnvMutation(response: Response): Promise<EnvApplication | undefined> {
  const body = await response.json().catch(() => ({})) as { error?: string; application?: EnvApplication };
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body.application;
}
export function describeEnvApplication(result?: EnvApplication): string {
  if (!result || result.state === 'stored') return 'Configuração salva. Será aplicada ao iniciar os serviços gerenciados; serviços externos mantêm seu próprio ambiente.';
  const failed = result.failed.map((entry) => entry.serviceId).join(', ');
  if (result.state === 'failed') return `Configuração salva, mas não aplicada: ${failed}. Tente novamente quando os serviços estiverem disponíveis.`;
  const applied = result.applied.join(', ');
  return `Arquivo de ambiente atualizado: ${applied}. Reinicie os processos que dependem dessas variáveis.${failed ? ` Falha ao aplicar: ${failed}.` : ''}`;
}
