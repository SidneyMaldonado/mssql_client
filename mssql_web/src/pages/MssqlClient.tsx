import React, { useEffect, useState } from 'react'
import './MssqlClient.css'

const MssqlClient: React.FC = () => {
  type Tab = {
    id: number
    title: string
    query: string
    columns: string[]
    rows: any[][]
    executing: boolean
    execError: string | null
    execMessage: string | null
    resultSets?: { columns: string[]; rows: any[][] }[]
    resultSetIndex?: number
  }

  const [tabs, setTabs] = useState<Tab[]>([
    { id: 1, title: 'Query 1', query: '', columns: [], rows: [], executing: false, execError: null, execMessage: null, resultSets: [], resultSetIndex: 0 },
  ])
  const [activeTabId, setActiveTabId] = useState<number>(1)

  const [tables, setTables] = useState<string[]>([])
  const [loadingTables, setLoadingTables] = useState(false)
  const [tablesError, setTablesError] = useState<string | null>(null)
  const [sidebarVisible, setSidebarVisible] = useState(true)

  useEffect(() => {
    const fetchTables = async () => {
      setLoadingTables(true)
      setTablesError(null)
      try {
        const res = await fetch('http://localhost:5068/api/Sql/tables')
        if (!res.ok) throw new Error(`Status ${res.status}`)
        const data = await res.json()

        let names: string[] = []
        if (Array.isArray(data)) {
          if (data.length === 0) names = []
          else if (typeof data[0] === 'string') names = data as string[]
          else if (typeof data[0] === 'object')
            names = (data as any[]).map((item) => item.name ?? item.tableName ?? item.TableName ?? JSON.stringify(item))
          else names = data.map(String)
        } else if (typeof data === 'object' && data !== null) {
          // fallback: try to extract values
          names = Object.values(data).map(String)
        }

        setTables(names)
      } catch (err) {
        setTablesError('Erro ao obter tabelas')
        setTables([])
      } finally {
        setLoadingTables(false)
      }
    }

    fetchTables()
  }, [])

  const getActiveTab = () => tabs.find((t) => t.id === activeTabId) ?? tabs[0]

  const updateTab = (id: number, patch: Partial<Tab>) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)))
  }

  const addTab = () => {
    setTabs((prev) => {
      const nextId = prev.reduce((s, t) => Math.max(s, t.id), 0) + 1
        const newTab: Tab = { id: nextId, title: `Query ${nextId}`, query: '', columns: [], rows: [], executing: false, execError: null, execMessage: null }
      setActiveTabId(nextId)
      return [...prev, newTab]
    })
  }

  const closeTab = (id: number) => {
    setTabs((prev) => {
      if (prev.length === 1) return prev // don't close last
      const idx = prev.findIndex((t) => t.id === id)
      const next = prev.filter((t) => t.id !== id)
      if (activeTabId === id) {
        const newActive = idx > 0 ? prev[idx - 1].id : next[0].id
        setActiveTabId(newActive)
      }
      return next
    })
  }

  const handleExecute = async () => {
    const tab = getActiveTab()
    if (!tab) return
    updateTab(tab.id, { execError: null, execMessage: null, columns: [], rows: [] })

    const sqlTrim = tab.query.trim()
    if (!sqlTrim) {
      updateTab(tab.id, { execError: 'Query vazia' })
      return
    }

    updateTab(tab.id, { executing: true })
    try {
      const res = await fetch('http://localhost:5068/api/Sql/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql: tab.query }),
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }))
        throw new Error(err.error ?? `Status ${res.status}`)
      }

      const data = await res.json()

      // If backend returned multiple result sets (sp_help)
      if (Array.isArray((data as any).resultSets)) {
        const sets = (data as any).resultSets.map((rs: any) => {
          const cols: string[] = Array.isArray(rs.columns) ? rs.columns : []
          let rows: any[][] = []
          if (Array.isArray(rs.rows)) {
            // rows may be array of objects (dictionary) -> convert to arrays aligned with cols
            if (rs.rows.length > 0 && typeof rs.rows[0] === 'object' && !Array.isArray(rs.rows[0])) {
              rows = rs.rows.map((r: any) => cols.map((c) => (r ? r[c] ?? null : null)))
            } else if (Array.isArray(rs.rows[0])) {
              rows = rs.rows
            } else {
              // fallback: convert values
              rows = rs.rows.map((r: any) => (Array.isArray(r) ? r : Object.values(r)))
            }
          }
          return { columns: cols, rows }
        })

        updateTab(tab.id, { resultSets: sets, resultSetIndex: 0, columns: [], rows: [], execError: null, execMessage: null })
        return
      }

      if (Array.isArray(data.columns) && Array.isArray(data.rows)) {
        updateTab(tab.id, { columns: data.columns, rows: data.rows, execError: null })
        return
      }

      if (Array.isArray(data.rows) && data.rows.length > 0 && typeof data.rows[0] === 'object') {
        const cols = Object.keys(data.rows[0])
        const rows = (data.rows as any[]).map((r) => cols.map((c) => r[c] ?? null))
        updateTab(tab.id, { columns: cols, rows, execError: null })
        return
      }

      if (data.affectedRows !== undefined) {
        updateTab(tab.id, { columns: [], rows: [], execError: null, execMessage: `Linhas afetadas: ${data.affectedRows}` })
        return
      }

      updateTab(tab.id, { columns: [], rows: [], execError: null, execMessage: JSON.stringify(data) })
    } catch (err: any) {
        updateTab(tab.id, { execError: err?.message ?? 'Erro ao executar consulta', execMessage: null })
    } finally {
        updateTab(tab.id, { executing: false })
    }
  }

  // Per-tab handlers: clear and keydown operate on the active tab
  const handleClear = () => {
    const tab = getActiveTab()
    if (!tab) return
    updateTab(tab.id, { query: '', columns: [], rows: [], execError: null })
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const tab = getActiveTab()
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      if (!tab?.executing) handleExecute()
    }
  }

  const renderExecMessage = (msg?: string | null) => {
    if (!msg) return null
    try {
      const parsed = JSON.parse(msg)
      return <pre className="exec-message-pre">{JSON.stringify(parsed, null, 2)}</pre>
    } catch {
      return <div>{msg}</div>
    }
  }

  return (
    <div className="mssql-container">
      <aside className={`sidebar ${sidebarVisible ? '' : 'hidden'}`}>
        <div className="sidebar-header">MSSQL</div>
        <nav>
          <ul>
            <li className="active">Workspace</li>
            <li>Connections</li>
            <li>History</li>
            <li>Settings</li>
          </ul>
        </nav>

        <div className="tables-section">
          <h3>Tabelas</h3>
          {loadingTables ? (
            <div className="tables-loading">Carregando...</div>
          ) : tablesError ? (
            <div className="tables-error">{tablesError}</div>
          ) : (
            <ul className="tables-list">
              {tables.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <button
            className="toggle-sidebar"
            onClick={() => setSidebarVisible((v) => !v)}
            aria-label="Alternar barra lateral"
          >
            {sidebarVisible ? '◀' : '☰'}
          </button>
          <h1>MSSQL Web Client</h1>
        </header>

        <main className="workspace">
          <div className="tabs-bar">
            {tabs.map((t) => (
              <div
                key={t.id}
                className={`tab ${t.id === activeTabId ? 'active' : ''}`}
                onClick={() => setActiveTabId(t.id)}
              >
                <span className="tab-title">{t.title}</span>
                <button
                  className="tab-close"
                  onClick={(e) => {
                    e.stopPropagation()
                    closeTab(t.id)
                  }}
                  aria-label="Fechar aba"
                >
                  ×
                </button>
              </div>
            ))}
            <button className="tab-add" onClick={addTab} aria-label="Nova aba">
              +
            </button>
          </div>

          <label className="editor-label">Query</label>
          {(() => {
            const active = getActiveTab()
            return (
              <>
                <textarea
                  className="query-box"
                  value={active?.query ?? ''}
                  onChange={(e) => active && updateTab(active.id, { query: e.target.value })}
                  onKeyDown={handleKeyDown}
                  placeholder="Escreva sua consulta SQL aqui..."
                  rows={12}
                />

                <div className="actions">
                  <button className="execute" onClick={handleExecute} disabled={active?.executing}>
                    Execute
                  </button>
                  <span className="shortcut-label">Ctrl/Cmd+Enter</span>
                  <button className="clear" onClick={handleClear} disabled={active?.executing}>
                    Limpar
                  </button>
                </div>

                {active?.execError && <div className="exec-error">{active.execError}</div>}
                {active?.executing && <div className="exec-loading">Executando...</div>}
                {active?.execMessage && <div className="exec-message">{renderExecMessage(active.execMessage)}</div>}

                {active && active.resultSets && active.resultSets.length > 0 ? (
                  <div className="results">
                    <h3>Resultados</h3>
                    <div className="result-sets-bar">
                      {active.resultSets.map((_, idx) => (
                        <button
                          key={idx}
                          className={`result-set-tab ${active.resultSetIndex === idx ? 'active' : ''}`}
                          onClick={() => updateTab(active.id, { resultSetIndex: idx })}
                        >
                          Result {idx + 1}
                        </button>
                      ))}
                    </div>
                    <div className="results-table-wrapper">
                      {(() => {
                        const idx = active.resultSetIndex ?? 0
                        const rs = active.resultSets![idx]
                        return (
                          <table className="results-table">
                            <thead>
                              <tr>
                                {rs.columns.map((c) => (
                                  <th key={c}>{c}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {rs.rows.map((row, ri) => (
                                <tr key={ri}>
                                  {row.map((cell, ci) => (
                                    <td key={ci}>{cell === null ? 'NULL' : String(cell)}</td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )
                      })()}
                    </div>
                  </div>
                ) : active && active.columns.length > 0 ? (
                  <div className="results">
                    <h3>Resultados</h3>
                    <div className="results-table-wrapper">
                      <table className="results-table">
                        <thead>
                          <tr>
                            {active.columns.map((c) => (
                              <th key={c}>{c}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {active.rows.map((row, ri) => (
                            <tr key={ri}>
                              {row.map((cell, ci) => (
                                <td key={ci}>{cell === null ? 'NULL' : String(cell)}</td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : null}
              </>
            )
          })()}
        </main>
      </div>
    </div>
  )
}

export default MssqlClient
