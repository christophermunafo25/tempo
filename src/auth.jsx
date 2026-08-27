import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { get, post } from './api.js'

/* Session state for the whole app. /api/auth/me answers 200 with a null user
   rather than 401, so the first load can decide between the app and the login
   screen without generating a console error every time. */

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      setUser((await get('/auth/me')).user)
    } catch {
      setUser(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  // Any request that comes back 401 means the cookie died mid-session —
  // revoked, expired, or past the absolute cap. Drop the user and the guard
  // sends them to the login screen on the next render.
  useEffect(() => {
    const onUnauthenticated = () => setUser(null)
    window.addEventListener('tempo-unauthenticated', onUnauthenticated)
    return () => window.removeEventListener('tempo-unauthenticated', onUnauthenticated)
  }, [])

  const signIn = useCallback(async (email, password) => {
    const { user } = await post('/auth/login', { email, password })
    setUser(user)
    return user
  }, [])

  const signOut = useCallback(async () => {
    try {
      await post('/auth/logout')
    } finally {
      setUser(null)
    }
  }, [])

  return (
    <AuthContext.Provider value={{ user, loading, signIn, signOut, refresh }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)
