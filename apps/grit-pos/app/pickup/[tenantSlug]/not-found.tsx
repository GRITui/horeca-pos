import { InvalidPickupLink } from "@/components/pickup/InvalidPickupLink";

// Rendered (with a real 404 status) when notFound() is called from
// app/pickup/[tenantSlug]/page.tsx for an invalid/unknown tenant slug.
export default function PickupNotFound() {
  return <InvalidPickupLink />;
}
