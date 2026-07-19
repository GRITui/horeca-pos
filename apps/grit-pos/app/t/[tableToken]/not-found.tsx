import { InvalidTableLink } from "@/components/qr/InvalidTableLink";

// Rendered (with a real 404 status) when notFound() is called from
// app/t/[tableToken]/page.tsx for an invalid/unknown table token.
export default function TableNotFound() {
  return <InvalidTableLink />;
}
