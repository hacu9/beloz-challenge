import type { Clock } from "../../platform/clock.js";
import type { Tx } from "../../platform/db/tx.js";
import { currentRequestId } from "../../platform/request-context.js";

export type ActorType = "customer" | "ops" | "network" | "bank" | "system";

export interface Actor {
  type: ActorType;
  id?: string;
}

export interface AuditEvent {
  actor: Actor;
  action: string;
  entityType: string;
  entityId: string;
  before: unknown;
  after: unknown;
}

// AUDIT-01, AUDIT-02: the caller passes its open transaction, so the audit row
// commits or rolls back together with the change it describes.
export class AuditLog {
  constructor(private readonly clock: Clock) {}

  async write(tx: Tx, event: AuditEvent): Promise<void> {
    await tx.query(
      `INSERT INTO audit_log
         (actor_type, actor_id, action, entity_type, entity_id, before, after, request_id, at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        event.actor.type,
        event.actor.id ?? null,
        event.action,
        event.entityType,
        event.entityId,
        event.before === undefined ? null : JSON.stringify(event.before),
        event.after === undefined ? null : JSON.stringify(event.after),
        currentRequestId() ?? null,
        this.clock.now(),
      ],
    );
  }
}
