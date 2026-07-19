import type { DeliveryStatus } from "@/generated/prisma/client";

/** assigned -> out_for_delivery -> delivered/failed; failed can be retried. */
const ALLOWED_TRANSITIONS: Record<DeliveryStatus, DeliveryStatus[]> = {
  assigned: ["out_for_delivery"],
  out_for_delivery: ["delivered", "failed"],
  delivered: [],
  failed: ["out_for_delivery"],
};

export function canTransitionDelivery(from: DeliveryStatus, to: DeliveryStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}
