// Generic "this pickup link doesn't work" screen. Deliberately says nothing
// about *why* (unknown slug vs malformed) or about any other tenant — same
// spirit as components/qr/InvalidTableLink.tsx.

export function InvalidPickupLink() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="text-4xl">⚠️</div>
      <h1 className="text-xl font-bold tracking-tight">This link isn&apos;t working</h1>
      <p className="max-w-sm text-sm text-zinc-600 dark:text-zinc-400">
        This pickup link is invalid or no longer active. Please double-check the link you were
        given.
      </p>
    </main>
  );
}
