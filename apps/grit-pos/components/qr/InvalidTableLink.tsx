// Generic "this QR code doesn't work" screen. Deliberately says nothing
// about *why* (unknown token vs malformed vs deactivated table) or about
// any other tenant/table — see lib/tokenLink.ts's verifyTableToken contract.

export function InvalidTableLink() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="text-4xl">⚠️</div>
      <h1 className="text-xl font-bold tracking-tight">This link isn&apos;t working</h1>
      <p className="max-w-sm text-sm text-zinc-600 dark:text-zinc-400">
        This table&apos;s QR code is invalid or no longer active. Please ask a staff member for a
        fresh code.
      </p>
    </main>
  );
}
