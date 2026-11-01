import Link from "next/link";
import { EmptyState } from "@/components/ui";

export default function NotFound() {
  return (
    <div className="page">
      <EmptyState
        title="Page not found"
        action={
          <Link className="btn btn-primary" href="/">
            Back to dashboard
          </Link>
        }
      >
        That page is not part of the loom yet.
      </EmptyState>
    </div>
  );
}
