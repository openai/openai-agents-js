import type { RunToolApprovalItem } from '@openai/agents';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from './ui/Button';
import { useEffect, useState } from 'react';

type Item = ReturnType<RunToolApprovalItem['toJSON']>;

function ToolApprovalEntry({
  approval,
  onApprove,
  onReject,
  decision,
}: {
  approval: Item;
  onApprove: () => void;
  onReject: () => void;
  decision: 'approved' | 'rejected' | undefined;
}) {
  if (approval.rawItem?.type !== 'function_call') {
    return null;
  }

  return (
    <div key={approval.rawItem?.id} className="flex flex-col gap-2">
      <h3 className="font-medium text-sm">
        Tool <code>{approval.rawItem?.name}</code>
      </h3>
      <pre className="text-sm bg-gray-50 p-4 rounded-md">
        {approval.rawItem?.arguments}
      </pre>
      {decision === undefined && (
        <div className="flex gap-2">
          <Button size="smRounded" variant="primary" onClick={onApprove}>
            Approve
          </Button>
          <Button size="smRounded" variant="secondary" onClick={onReject}>
            Reject
          </Button>
        </div>
      )}
      {decision === 'approved' && (
        <p className="text-sm text-green-700">✔︎ Approved</p>
      )}
      {decision === 'rejected' && (
        <p className="text-sm text-red-500">✖︎ Rejected</p>
      )}
    </div>
  );
}

/**
 * This component just renders all of the approval requests and tracks whether they were approved
 * or not by storing the callId in a decision Map with `approved` or `rejected` as the value.
 * Once all the approvals are done, we will call the onDone function to let the parent component
 * trigger the next run.
 */
export function Approvals({
  approvals,
  onDone,
}: {
  approvals: ReturnType<RunToolApprovalItem['toJSON']>[];
  onDone: (decisions: Map<string, 'approved' | 'rejected'>) => void;
}) {
  const [decisions, setDecisions] = useState<
    Map<string, 'approved' | 'rejected'>
  >(new Map());
  const [isOpen, setIsOpen] = useState(approvals.length > 0);

  useEffect(() => {
    setDecisions(new Map());
    if (approvals.length > 0) {
      setIsOpen(true);
    }
  }, [approvals]);

  function handleApprove(approval: Item) {
    setDecisions((prev) => {
      if (approval.rawItem?.type !== 'function_call') {
        return prev;
      }
      const newDecisions = new Map(prev);
      newDecisions.set(approval.rawItem?.callId ?? '', 'approved');
      return newDecisions;
    });
  }

  function handleReject(approval: Item) {
    setDecisions((prev) => {
      if (approval.rawItem?.type !== 'function_call') {
        return prev;
      }
      const newDecisions = new Map(prev);
      newDecisions.set(approval.rawItem?.callId ?? '', 'rejected');
      return newDecisions;
    });
  }

  function handleDone() {
    onDone(decisions);
    setIsOpen(false);
  }

  if (approvals.length === 0) {
    return null;
  }

  const agentName = approvals[0].agent.name;

  return (
    <Dialog open={isOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Approval required</DialogTitle>
          <DialogDescription>
            The agent {agentName} is requesting approval for the following
            action{approvals.length > 1 ? 's' : ''}:
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-8">
          {approvals.map((approval) =>
            approval.rawItem?.type === 'function_call' ? (
              <ToolApprovalEntry
                key={approval.rawItem?.callId}
                approval={approval}
                decision={decisions.get(approval.rawItem?.callId ?? '')}
                onApprove={() => handleApprove(approval)}
                onReject={() => handleReject(approval)}
              />
            ) : null,
          )}
        </div>
        <DialogFooter>
          <Button
            variant="primary"
            type="submit"
            disabled={decisions.size !== approvals.length}
            onClick={handleDone}
          >
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
