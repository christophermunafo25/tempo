import React from 'react'
import ReactDOM from 'react-dom/client'
import { createBrowserRouter, RouterProvider, Navigate } from 'react-router-dom'
import App from './App.jsx'
import Clock from './screens/Clock.jsx'
import Dashboard from './screens/Dashboard.jsx'
import Board from './screens/Board.jsx'
import Timesheets from './screens/Timesheets.jsx'
import Expenses from './screens/Expenses.jsx'
import Login from './screens/Login.jsx'
import SetPassword from './screens/SetPassword.jsx'
import Portal from './screens/Portal.jsx'
import Forgot from './screens/Forgot.jsx'
import PortalApp from './portal/PortalApp.jsx'
import PortalOverview from './portal/screens/Overview.jsx'
import PortalHours from './portal/screens/Hours.jsx'
import PortalProjects from './portal/screens/Projects.jsx'
import PortalProjectDetail from './portal/screens/ProjectDetail.jsx'
import ShareApp from './share/ShareApp.jsx'
import { AuthProvider } from './auth.jsx'
import './styles/app.css'

const router = createBrowserRouter([
  // Outside App on purpose: the login screen must not render the owner nav.
  { path: '/login', element: <Login /> },
  // Invite and reset links land here. Public: the whole point is that the
  // recipient has no account yet.
  { path: '/portal/set-password', element: <SetPassword /> },
  { path: '/forgot', element: <Forgot /> },
  // No account, no session, no nav. A sibling of both shells so neither the
  // owner's navigation nor the client portal's exists in this tree at all.
  { path: '/s/:token', element: <ShareApp /> },
  // The client's own shell. A sibling of App, never a child of it, so the
  // owner nav is not merely hidden from clients — it is never in their tree.
  {
    path: '/portal',
    element: <PortalApp />,
    children: [
      { index: true, element: <PortalOverview /> },
      { path: 'hours', element: <PortalHours /> },
      { path: 'projects', element: <PortalProjects /> },
      { path: 'projects/:id', element: <PortalProjectDetail /> },
      { path: '*', element: <Navigate to="/portal" replace /> },
    ],
  },
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Clock /> },
      { path: 'dashboard', element: <Dashboard /> },
      { path: 'board', element: <Board /> },
      { path: 'timesheets', element: <Timesheets /> },
      { path: 'expenses', element: <Expenses /> },
      // /access, not /portal: the client shell owns /portal, and two routes
      // matching the same path silently hid this screen.
      { path: 'access', element: <Portal /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
])

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthProvider>
      <RouterProvider router={router} future={{ v7_startTransition: true }} />
    </AuthProvider>
  </React.StrictMode>,
)
