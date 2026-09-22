import type { CapabilityManifest } from 'jevrouter';
import type { Config } from '../config.js';

// Both explicit selection and hosted decisions cross this same execution gate.
// Hosted decisions additionally retain every assessment performed by JevRouter.
export function assessCandidate(config: Config, candidate: CapabilityManifest): { allowed: boolean; confirmation: boolean; reason?: string } {
  const risk = candidate.risk?.level ?? 'low';
  const reason = !candidate.availability?.available ? candidate.availability?.reason ?? 'Unavailable'
    : candidate.permissions?.some(permission => !config.policy.permissions.includes(permission as Config['policy']['permissions'][number])) ? 'Missing permission'
    : !config.policy.router.allowed_risk_levels.includes(risk) ? 'Risk level not allowed'
    : config.policy.router.require_verified_candidates && candidate.verification?.status !== 'verified' ? 'Capability is not verified'
    : undefined;
  return { allowed: !reason, reason, confirmation: Boolean(candidate.policy?.requires_confirmation || config.policy.router.confirmation_risk_levels.includes(risk)) };
}
