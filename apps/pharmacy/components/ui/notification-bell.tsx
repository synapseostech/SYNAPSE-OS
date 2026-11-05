"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Bell, Check, Trash2, X, ShoppingBag, UserCheck, AlertCircle, Edit } from "lucide-react"
import { useRouter } from "next/navigation"
import { formatDistanceToNow } from "date-fns"

interface Notification {
  id: string
  type: string
  title: string
  message: string
  relatedId?: string
  isRead: boolean
  createdAt: string
}

export function NotificationBell() {
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [isOpen, setIsOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const router = useRouter()
  const bellRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!isOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      setIsOpen(false)
      bellRef.current?.focus()
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [isOpen])

  const fetchNotifications = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/notifications?limit=10")
      if (response.ok) {
        const data = await response.json()
        setNotifications(data.notifications)
        setUnreadCount(data.unreadCount)
      }
    } catch (error) {
      console.error("Failed to fetch notifications:", error)
    }
  }, [])

  // Clean up orphaned notifications (for orders that are completed/cancelled/deleted)
  const cleanupOrphanedNotifications = useCallback(async () => {
    try {
      await fetch("/api/admin/notifications?cleanup=true", {
        method: "DELETE",
      })
      // Refetch after cleanup
      fetchNotifications()
    } catch (error) {
      console.error("Failed to cleanup notifications:", error)
    }
  }, [fetchNotifications])

  useEffect(() => {
    // The cleanup is a DELETE: once per browser session is enough, and a portal
    // that reopens a dozen times a day must not fire a write on every mount.
    const CLEANUP_KEY = "notifications-cleaned"
    let cleaned = false
    try {
      cleaned = window.sessionStorage.getItem(CLEANUP_KEY) === "1"
    } catch {
      // Storage blocked: fall back to cleaning every mount rather than never.
    }
    if (cleaned) {
      fetchNotifications()
    } else {
      try {
        window.sessionStorage.setItem(CLEANUP_KEY, "1")
      } catch {
        // ignore
      }
      cleanupOrphanedNotifications()
    }

    // Poll for new notifications every 30 seconds
    const interval = setInterval(fetchNotifications, 30000)
    return () => clearInterval(interval)
  }, [fetchNotifications, cleanupOrphanedNotifications])

  const markAsRead = async (notificationIds?: string[]) => {
    try {
      await fetch("/api/admin/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          notificationIds,
          markAll: !notificationIds,
        }),
      })
      fetchNotifications()
    } catch (error) {
      console.error("Failed to mark notifications as read:", error)
    }
  }

  const deleteNotification = async (notificationId: string) => {
    try {
      await fetch(`/api/admin/notifications?id=${notificationId}`, {
        method: "DELETE",
      })
      fetchNotifications()
    } catch (error) {
      console.error("Failed to delete notification:", error)
    }
  }

  const handleNotificationClick = async (notification: Notification) => {
    if (!notification.isRead) {
      await markAsRead([notification.id])
    }

    if (notification.type === "NEW_ORDER" || notification.type === "ORDER_CLAIMED") {
      router.push("/portal/orders")
    } else if (notification.type === "TRANSACTION_EDIT") {
      router.push("/portal/transactions")
    }

    setIsOpen(false)
  }

  const getNotificationIcon = (type: string) => {
    switch (type) {
      case "NEW_ORDER":
        return <ShoppingBag className="h-5 w-5 text-blue-500" />
      case "ORDER_CLAIMED":
        return <UserCheck className="h-5 w-5 text-green-500" />
      case "TRANSACTION_EDIT":
        return <Edit className="h-5 w-5 text-amber-600" />
      default:
        return <AlertCircle className="h-5 w-5 text-gray-500" />
    }
  }

  return (
    <div className="relative">
      <Button
        ref={bellRef}
        variant="ghost"
        size="icon"
        className="relative"
        aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications"}
        aria-expanded={isOpen}
        onClick={() => setIsOpen(!isOpen)}
      >
        <Bell className="h-5 w-5" />
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs rounded-full h-5 w-5 flex items-center justify-center animate-pulse">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </Button>

      {isOpen && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setIsOpen(false)}
          />
          <div className="absolute right-0 mt-2 w-80 sm:w-96 bg-white rounded-lg shadow-xl border z-50 max-h-[70vh] overflow-hidden">
            <div className="p-4 border-b flex justify-between items-center bg-gray-50">
              <h3 className="font-semibold">Notifications</h3>
              <div className="flex items-center gap-2">
                {unreadCount > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => markAsRead()}
                    className="text-xs"
                  >
                    <Check className="h-3 w-3 mr-1" />
                    Mark all read
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  aria-label="Close notifications"
                  onClick={() => setIsOpen(false)}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <div className="overflow-y-auto max-h-[50vh]">
              {notifications.length === 0 ? (
                <div className="p-8 text-center text-gray-500">
                  <Bell className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p>No notifications</p>
                </div>
              ) : (
                <div className="divide-y">
                  {notifications.map((notification) => (
                    <div
                      key={notification.id}
                      className={`p-4 hover:bg-gray-50 cursor-pointer transition-colors ${!notification.isRead ? "bg-blue-50/50" : ""
                        }`}
                      onClick={() => handleNotificationClick(notification)}
                    >
                      <div className="flex gap-3">
                        <div className="flex-shrink-0 mt-1">
                          {getNotificationIcon(notification.type)}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex justify-between items-start">
                            <p className={`text-sm font-medium ${!notification.isRead ? "text-blue-900" : "text-gray-900"}`}>
                              {notification.title}
                            </p>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6 -mt-1 -mr-2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                              aria-label={`Delete notification: ${notification.title}`}
                              onClick={(e) => {
                                e.stopPropagation()
                                deleteNotification(notification.id)
                              }}
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </div>
                          <p className="text-sm text-gray-600 truncate">
                            {notification.message}
                          </p>
                          <p className="text-xs text-gray-400 mt-1">
                            {formatDistanceToNow(new Date(notification.createdAt), {
                              addSuffix: true,
                            })}
                          </p>
                        </div>
                        {!notification.isRead && (
                          <div className="flex-shrink-0">
                            <div className="h-2 w-2 bg-blue-500 rounded-full" />
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {notifications.length > 0 && (
              <div className="p-3 border-t bg-gray-50 text-center">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-sm text-primary"
                  onClick={() => {
                    router.push("/portal/orders")
                    setIsOpen(false)
                  }}
                >
                  View All Orders
                </Button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
