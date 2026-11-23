export default function DashboardLoading() {
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-8 sm:px-6" aria-busy="true">
      <h1 className="text-2xl font-bold tracking-tight">Portfolio</h1>
      <p role="status" className="text-sm text-zinc-600 dark:text-zinc-400">
        Loading your account…
      </p>
    </main>
  );
}
