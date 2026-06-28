/** Checkout-cancelled landing. Stripe redirects here when the user backs out of
 *  the hosted checkout — no charge was made. Purely informational. */
import { useNavigate } from 'react-router-dom';
import { XCircle } from 'lucide-react';
import { Button, Card, CardContent, CardHeader, CardTitle } from '../lib/ui.js';

export function BillingCancelPage() {
  const navigate = useNavigate();
  return (
    <div className="mx-auto max-w-md py-16">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <XCircle className="h-5 w-5 text-muted-foreground" /> Checkout cancelled
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <p className="text-muted-foreground">No charge was made. You can upgrade any time from the billing page.</p>
          <div className="flex gap-2 pt-1">
            <Button size="sm" onClick={() => navigate('/billing')}>
              Back to billing
            </Button>
            <Button size="sm" variant="outline" onClick={() => navigate('/')}>
              Overview
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
