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
import { AuthProvider } from './auth.jsx'
import './styles/app.css'

const router = createBrowserRouter([
  // Outside App on purpose: the login screen must not render the owner nav.
  { path: '/login', element: <Login /> },
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Clock /> },
      { path: 'dashboard', element: <Dashboard /> },
      { path: 'board', element: <Board /> },
      { path: 'timesheets', element: <Timesheets /> },
      { path: 'expenses', element: <Expenses /> },
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
