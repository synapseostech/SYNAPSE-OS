// Without this, a navigation shows the old page until the server render and the
// middleware's access checks finish, which reads as a frozen app.
export default function PortalLoading() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div
        className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary"
        role="status"
        aria-label="Loading"
      />
    </div>
  )
}
