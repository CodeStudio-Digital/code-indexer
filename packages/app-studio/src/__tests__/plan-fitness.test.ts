import { describe, expect, it } from 'vitest';
import { auditAppPlan } from '../plan/fitness.js';
import { emptyAppPlan } from '../plan/types.js';

describe('AppPlanV1 fitness', () => {
  function hotelPlan() {
    const plan = emptyAppPlan();
    plan.intent.summary = 'Busca de quartos e reserva de hotel confiável para viajantes.';
    plan.intent.audience = 'Viajantes';
    plan.intent.goals.push({ id: 'goal:hotel', text: 'Encontrar e reservar quartos.' });
    plan.scope.capabilities.push(
      { id: 'cap:search', name: 'Busca', description: 'Buscar quartos', selected: true, critical: false, quality_attributes: ['read-heavy'], source_ids: ['goal:hotel'] },
      { id: 'cap:booking', name: 'Reserva', description: 'Confirmar reserva', selected: true, critical: true, quality_attributes: ['consistency'], source_ids: ['goal:hotel'] },
    );
    plan.scope.acceptance.push(
      { id: 'accept:search', text: 'Lista quartos disponíveis', capability_ids: ['cap:search'] },
      { id: 'accept:booking', text: 'Não duplica reserva', capability_ids: ['cap:booking'] },
    );
    plan.experience.screens.push(
      { id: 'screen:search', name: 'Busca', purpose: 'Encontrar', route: '/', primary: true, protected: false, capability_ids: ['cap:search'], states: [] },
      { id: 'screen:booking', name: 'Reserva', purpose: 'Confirmar', route: '/booking', primary: false, protected: false, capability_ids: ['cap:booking'], states: [] },
    );
    plan.data.required = true;
    plan.data.entities.push({ id: 'entity:booking', name: 'bookings', label: 'Reservas', fields: [] });
    plan.delivery.tests.push(
      { id: 'test:search', title: 'Busca', kind: 'worker', source_ids: ['cap:search'], expected: 'Quartos disponíveis' },
      { id: 'test:booking', title: 'Clique duplicado', kind: 'database', source_ids: ['cap:booking'], expected: 'Uma reserva' },
    );
    plan.delivery.slices.push(
      { id: 'slice:search', name: 'Busca', capability_ids: ['cap:search'], screen_ids: ['screen:search'], entity_ids: [], test_ids: ['test:search'], depends_on: [] },
      { id: 'slice:booking', name: 'Reserva', capability_ids: ['cap:booking'], screen_ids: ['screen:booking'], entity_ids: ['entity:booking'], test_ids: ['test:booking'], depends_on: ['slice:search'] },
    );
    plan.engineering.critical_writes.push({ id: 'write:booking', capability_id: 'cap:booking', entity: 'bookings', idempotency: 'request key', consistency: 'transaction', constraint: 'unique room/date', test_id: 'test:booking' });
    plan.engineering.components.push(
      { id: 'component:spa', kind: 'spa', name: 'Web', responsibility: 'Busca e reserva', consumer_ids: ['screen:search'], source_ids: ['cap:search'] },
      { id: 'component:worker', kind: 'worker', name: 'API', responsibility: 'Regras de disponibilidade', consumer_ids: ['cap:booking'], source_ids: ['cap:booking'] },
      { id: 'component:d1', kind: 'd1', name: 'D1', responsibility: 'Integridade das reservas', consumer_ids: ['entity:booking'], source_ids: ['cap:booking'] },
    );
    return plan;
  }

  it('accepts distinct search and idempotent booking flows on the provisioned stack', () => {
    expect(auditAppPlan(hotelPlan()).status).toBe('ready');
  });

  it('rejects cache until the active stack can really provision it', () => {
    const plan = hotelPlan();
    plan.engineering.components.push({ id: 'component:cache', kind: 'cache', name: 'Cache', responsibility: 'Busca popular', consumer_ids: ['slice:search'], source_ids: ['cap:search'] });
    const report = auditAppPlan(plan);
    expect(report.checks).toContainEqual(expect.objectContaining({ id: 'component.component:cache.supported', status: 'fail' }));
  });

  it('rejects decorative queues without a consumer', () => {
    const plan = emptyAppPlan();
    plan.intent.summary = 'Reservas de hotéis com busca e confirmação confiável.';
    plan.intent.audience = 'Viajantes';
    plan.intent.goals.push({ id: 'goal:booking', text: 'Reservar um quarto sem duplicidade.' });
    plan.scope.capabilities.push({
      id: 'cap:booking', name: 'Reserva', description: 'Confirmar reserva', selected: true,
      critical: true, quality_attributes: ['consistency'], source_ids: ['goal:booking'],
    });
    plan.scope.acceptance.push({ id: 'accept:booking', text: 'Não duplica reserva', capability_ids: ['cap:booking'] });
    plan.experience.screens.push({ id: 'screen:booking', name: 'Reserva', purpose: 'Confirmar', route: '/booking', primary: true, protected: false, capability_ids: ['cap:booking'], states: [] });
    plan.data.required = true;
    plan.data.entities.push({ id: 'entity:booking', name: 'bookings', label: 'Reservas', fields: [] });
    plan.delivery.tests.push({ id: 'test:booking', title: 'Clique duplicado', kind: 'database', source_ids: ['cap:booking'], expected: 'Uma reserva' });
    plan.delivery.slices.push({ id: 'slice:booking', name: 'Reserva', capability_ids: ['cap:booking'], screen_ids: ['screen:booking'], entity_ids: ['entity:booking'], test_ids: ['test:booking'], depends_on: [] });
    plan.engineering.critical_writes.push({ id: 'write:booking', capability_id: 'cap:booking', entity: 'bookings', idempotency: 'request key', consistency: 'transaction', constraint: 'unique room/date', test_id: 'test:booking' });
    plan.engineering.components.push({ id: 'component:queue', kind: 'queue', name: 'Fila', responsibility: 'Sem consumidor', consumer_ids: [], source_ids: ['goal:booking'] });

    const report = auditAppPlan(plan, new Date('2026-07-16T00:00:00Z'));
    expect(report.status).toBe('blocked');
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'component.component:queue.consumer', status: 'fail' }),
    ]));
  });
});
