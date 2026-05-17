/**
 * Top-level routing component for the QA "Testes" tab. Three internal
 * panes (Plan / Live / History) selected via shadcn Tabs. Each pane is
 * a self-contained sub-component — this file stays a small composer.
 *
 * v4.2: header now hosts the `ServiceSwitcher` (only renders when the
 * session has more than one microservice). Selected `serviceId`
 * propagates down to all sub-views so they filter consistently.
 */
import React, { useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../components/ui/tabs.js';
import { TestPlanView } from './plan/TestPlanView.js';
import { LiveRunView } from './live/LiveRunView.js';
import { RunHistoryTable } from './history/RunHistoryTable.js';
import { ServiceSwitcher } from './shared/ServiceSwitcher.js';
import { UrlsDrawer } from './shared/UrlsDrawer.js';
import { RestoreQaConfigButton } from './shared/RestoreQaConfigButton.js';

interface Props {
  sessionId: number;
}

export function TestsTab({ sessionId }: Props) {
  const [serviceId, setServiceId] = useState<string>('main');

  return (
    <Tabs defaultValue="live" className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 mt-2">
        <TabsList className="w-fit">
          <TabsTrigger value="live" className="text-xs">Live</TabsTrigger>
          <TabsTrigger value="history" className="text-xs">Histórico</TabsTrigger>
          <TabsTrigger value="plan" className="text-xs">Plano</TabsTrigger>
        </TabsList>
        <div className="flex items-center gap-2">
          <ServiceSwitcher
            sessionId={sessionId}
            value={serviceId}
            onChange={setServiceId}
          />
          <RestoreQaConfigButton sessionId={sessionId} />
          <UrlsDrawer sessionId={sessionId} />
        </div>
      </div>
      <TabsContent value="live" className="flex-1 overflow-hidden mt-0">
        <LiveRunView sessionId={sessionId} serviceId={serviceId} />
      </TabsContent>
      <TabsContent value="history" className="flex-1 overflow-auto mt-0">
        <RunHistoryTable sessionId={sessionId} serviceId={serviceId} />
      </TabsContent>
      <TabsContent value="plan" className="flex-1 overflow-hidden mt-0">
        <TestPlanView sessionId={sessionId} />
      </TabsContent>
    </Tabs>
  );
}
