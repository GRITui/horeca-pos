import { PageHeader } from "@/components/ui";
import { NewProductForm } from "@/components/product-form";

export default function NewProductPage() {
  return (
    <div>
      <PageHeader title="New product" />
      <NewProductForm />
    </div>
  );
}
