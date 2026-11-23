'use strict';

/**
 * Append-only audit log. Every write route records who changed what.
 * There is intentionally NO update or delete path for audit_log anywhere
 * in the app (a DB trigger blocking UPDATE/DELETE lands in Pass 4).
 */

async function audit(q, { actor, clinicId, entity, entityId, action, detail }) {
  await q(
    `INSERT INTO audit_log (actor_name, actor_role, clinic_id, entity, entity_id, action, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      actor ? actor.name : 'system',
      actor ? actor.role : 'owner',
      clinicId === undefined ? null : clinicId,
      entity,
      entityId === undefined ? null : entityId,
      action,
      detail ? JSON.stringify(detail) : '{}',
    ]
  );
}

module.exports = { audit };
