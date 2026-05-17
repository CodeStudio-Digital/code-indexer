import React from 'react';
import { Card, CardContent } from '../../components/ui/card.js';

interface StatCardProps {
  icon: React.ElementType;
  label: string;
  value: React.ReactNode;
}

export function StatCard({ icon: Icon, label, value }: StatCardProps) {
  return (
    <Card className="shadow-none">
      <CardContent className="p-4 flex items-center gap-3">
        <div className="h-9 w-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
          <div className="text-lg font-semibold tabular-nums truncate">{value}</div>
        </div>
      </CardContent>
    </Card>
  );
}
