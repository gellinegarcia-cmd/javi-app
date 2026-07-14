import { useState, useRef, useEffect, useCallback } from 'react'

const API = 'https://kiosco-ai.onrender.com'

const S = {
  bg: '#0D1117',
  surface: '#161B22',
  surface2: '#21262D',
  border: '#21262D',
  text: '#E6EDF3',
  muted: '#8B949E',
  dim: '#30363D',
  blue: '#3B82F6',
  blueDark: '#1D3557',
  green: '#22C55E',
  amber: '#F59E0B',
  red: '#EF4444',
}

function fechaHoy() {
  return new Date().toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

function pad(n) { return String(n).padStart(2, '0') }
function fmtTime(s) {
  return pad(Math.floor(s / 3600)) + ':' + pad(Math.floor(s % 3600 / 60)) + ':' + pad(s % 60)
}

export default function App() {
  const [grabando, setGrabando] = useState(false)
  const [segundos, setSegundos] = useState(0)
  const [pacientes, setPacientes] = useState([])
  const [mensajes, setMensajes] = useState([])
  const [pendientes, setPendientes] = useState(0)
  const [alertas, setAlertas] = useState(0)
  const [evoluciones, setEvoluciones] = useState(0)
  const [tab, setTab] = useState('inicio')
  const [consultaActiva, setConsultaActiva] = useState(false)
  const [consultaTexto, setConsultaTexto] = useState('')
  const [respondiendo, setRespondiendo] = useState(false)

  const mediaRef = useRef(null)
  const chunksRef = useRef([])
  const timerRef = useRef(null)
  const guardiaId = useRef('G' + Date.now().toString(36).toUpperCase())
  const procesandoRef = useRef(false)

  useEffect(() => {
    const guardiaGuardada = localStorage.getItem('javi_guardia')
    if (guardiaGuardada) {
      const g = JSON.parse(guardiaGuardada)
      setSegundos(g.segundos || 0)
      setPacientes(g.pacientes || [])
      setMensajes(g.mensajes || [])
      setPendientes(g.pendientes || 0)
      setAlertas(g.alertas || 0)
      setEvoluciones(g.evoluciones || 0)
      guardiaId.current = g.id || guardiaId.current
    }
  }, [])

  useEffect(() => {
    localStorage.setItem('javi_guardia', JSON.stringify({
      id: guardiaId.current,
      segundos, pacientes, mensajes, pendientes, alertas, evoluciones
    }))
  }, [segundos, pacientes, mensajes, pendientes, alertas, evoluciones])

  const hablarConVoz = useCallback((texto) => {
    if (!window.speechSynthesis) return
    window.speechSynthesis.cancel()
    const u = new SpeechSynthesisUtterance(texto)
    u.lang = 'es-AR'
    u.rate = 0.95
    u.pitch = 1
    const voces = window.speechSynthesis.getVoices()
    const voz = voces.find(v => v.lang.startsWith('es')) || voces[0]
    if (voz) u.voice = voz
    window.speechSynthesis.speak(u)
  }, [])

  const procesarAudio = useCallback(async (blob) => {
    if (procesandoRef.current) return
    procesandoRef.current = true
    try {
      const mimeType = blob.type || 'audio/webm'
      const ext = mimeType.includes('mp4') ? 'audio.mp4' : 'audio.webm'
      const fd = new FormData()
      fd.append('audio', blob, ext)
      fd.append('guardia_id', guardiaId.current)
      fd.append('timestamp', new Date().toISOString())

      const resAudio = await fetch(`${API}/javi/audio`, { method: 'POST', body: fd })
      if (!resAudio.ok) return
      const audioData = await resAudio.json()
      if (!audioData.transcripcion || audioData.transcripcion.trim().length < 5) return

      const resProcesar = await fetch(`${API}/javi/procesar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transcripcion: audioData.transcripcion,
          guardia_id: guardiaId.current,
          pacientes_actuales: pacientes,
          timestamp: new Date().toISOString(),
        })
      })
      if (!resProcesar.ok) return
      const data = await resProcesar.json()

      if (data.pacientes_detectados?.length) {
        setPacientes(prev => {
          const mapa = {}
          prev.forEach(p => mapa[p.id] = p)
          data.pacientes_detectados.forEach(p => {
            if (mapa[p.id]) {
              mapa[p.id] = { ...mapa[p.id], ...p }
            } else {
              mapa[p.id] = p
            }
          })
          return Object.values(mapa)
        })
        setEvoluciones(prev => prev + data.pacientes_detectados.length)
      }

      if (data.mensaje_javi) {
        const nuevo = {
          id: Date.now(),
          tipo: data.tipo_mensaje || 'clinico',
          texto: data.mensaje_javi,
          hora: new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })
        }
        setMensajes(prev => [nuevo, ...prev].slice(0, 10))
        if (data.tipo_mensaje === 'importante') {
          hablarConVoz(data.mensaje_javi)
        }
      }

      if (data.nuevos_pendientes) setPendientes(prev => prev + data.nuevos_pendientes)
      if (data.nuevas_alertas) setAlertas(prev => prev + data.nuevas_alertas)

    } catch (e) {
      console.error('Error procesando audio:', e)
    } finally {
      procesandoRef.current = false
    }
  }, [pacientes, hablarConVoz])

  const iniciarGrabacion = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 16000 }
      })
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4'

      const grabarBloque = () => {
        if (!grabando && mediaRef.current?.state !== 'recording') return
        chunksRef.current = []
        const mr = new MediaRecorder(stream, mimeType ? { mimeType } : {})
        mr.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data) }
        mr.onstop = async () => {
          if (chunksRef.current.length > 0) {
            const blob = new Blob(chunksRef.current, { type: mimeType || 'audio/webm' })
            if (blob.size > 2000) await procesarAudio(blob)
          }
        }
        mr.start()
        mediaRef.current = mr
        setTimeout(() => {
          if (mr.state === 'recording') {
            mr.stop()
            setTimeout(grabarBloque, 500)
          }
        }, 30000)
      }

      grabarBloque()
      setGrabando(true)
      timerRef.current = setInterval(() => setSegundos(s => s + 1), 1000)

      setMensajes(prev => [{
        id: Date.now(),
        tipo: 'sistema',
        texto: 'Estoy escuchando tu guardia. Podés hablar con normalidad.',
        hora: new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })
      }, ...prev])

    } catch (e) {
      alert('Error al acceder al micrófono: ' + e.message)
    }
  }, [grabando, procesarAudio])

  const detenerGrabacion = useCallback(() => {
    if (mediaRef.current?.state === 'recording') {
      mediaRef.current.stop()
      mediaRef.current.stream?.getTracks().forEach(t => t.stop())
    }
    clearInterval(timerRef.current)
    setGrabando(false)
  }, [])

  const consultarJavi = useCallback(async (texto) => {
    if (!texto.trim() || respondiendo) return
    setRespondiendo(true)
    setConsultaTexto('')
    try {
      const res = await fetch(`${API}/javi/consulta`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pregunta: texto,
          guardia_id: guardiaId.current,
          pacientes: pacientes,
          timestamp: new Date().toISOString(),
        })
      })
      const data = await res.json()
      if (data.respuesta) {
        const nuevo = {
          id: Date.now(),
          tipo: 'respuesta',
          pregunta: texto,
          texto: data.respuesta,
          hora: new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })
        }
        setMensajes(prev => [nuevo, ...prev].slice(0, 10))
        hablarConVoz(data.respuesta)
      }
    } catch (e) {
      console.error('Error consultando:', e)
    }
    setRespondiendo(false)
  }, [respondiendo, pacientes, hablarConVoz])

  const grabarConsulta = useCallback(async () => {
    setConsultaActiva(true)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/mp4'
      const chunks = []
      const mr = new MediaRecorder(stream, mimeType ? { mimeType } : {})
      mr.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data) }
      mr.onstop = async () => {
        stream.getTracks().forEach(t => t.stop())
        const blob = new Blob(chunks, { type: mimeType || 'audio/webm' })
        const fd = new FormData()
        fd.append('audio', blob, mimeType?.includes('mp4') ? 'consulta.mp4' : 'consulta.webm')
        fd.append('guardia_id', guardiaId.current)
        const res = await fetch(`${API}/javi/audio`, { method: 'POST', body: fd })
        const data = await res.json()
        if (data.transcripcion) await consultarJavi(data.transcripcion)
        setConsultaActiva(false)
      }
      mr.start()
      setTimeout(() => { if (mr.state === 'recording') mr.stop() }, 8000)
    } catch (e) {
      setConsultaActiva(false)
      alert('Error micrófono')
    }
  }, [consultarJavi])

  const nuevaGuardia = () => {
    if (!window.confirm('¿Iniciás una guardia nueva? Se perderán los datos actuales.')) return
    localStorage.removeItem('javi_guardia')
    setGrabando(false)
    setSegundos(0)
    setPacientes([])
    setMensajes([])
    setPendientes(0)
    setAlertas(0)
    setEvoluciones(0)
    guardiaId.current = 'G' + Date.now().toString(36).toUpperCase()
  }

  return (
    <div style={{ background: S.bg, minHeight: '100vh', maxWidth: 390, margin: '0 auto', display: 'flex', flexDirection: 'column', fontFamily: '-apple-system,BlinkMacSystemFont,"SF Pro Text",Inter,sans-serif' }}>

      <div style={{ padding: '14px 18px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 11, color: S.dim }}>
          {new Date().toLocaleDateString('es-AR', { weekday: 'short', day: '2-digit', month: 'short' })}
        </span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {grabando && <div style={{ width: 7, height: 7, borderRadius: '50%', background: S.green, animation: 'blink 1.5s infinite' }} />}
          <button onClick={nuevaGuardia} style={{ background: 'none', border: 'none', color: S.muted, cursor: 'pointer', fontSize: 12 }}>nueva guardia</button>
        </div>
      </div>

      <div style={{ padding: '14px 18px 12px', borderBottom: `0.5px solid ${S.border}` }}>
        <div style={{ fontSize: 10, color: S.dim, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 4 }}>Guardia activa</div>
        <div style={{ fontSize: 22, fontWeight: 500, color: S.text, letterSpacing: '0.01em' }}>JAVI</div>
        <div style={{ fontSize: 12, color: S.blue, marginTop: 2 }}>Tu compañero de guardia</div>
        <div style={{ marginTop: 12, background: S.surface, border: `0.5px solid ${S.border}`, borderRadius: 8, padding: '9px 13px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ width: 7, height: 7, borderRadius: '50%', background: grabando ? S.green : S.dim, animation: grabando ? 'blink 1.5s infinite' : 'none' }} />
            <span style={{ fontSize: 13, color: grabando ? S.green : S.muted, fontWeight: 500 }}>
              {grabando ? 'Grabando' : 'En pausa'}
            </span>
          </div>
          <span style={{ fontSize: 13, color: S.text, fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>
            {fmtTime(segundos)}
          </span>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, padding: '12px 18px' }}>
        {[
          { val: pacientes.length, lbl: 'Pacientes', color: S.blue, icon: '👥' },
          { val: evoluciones, lbl: 'Evoluciones', color: S.blue, icon: '📋' },
          { val: pendientes, lbl: 'Pendientes', color: S.amber, icon: '⏰' },
          { val: alertas, lbl: 'Alertas', color: S.red, icon: '🔔' },
        ].map((m, i) => (
          <div key={i} style={{ background: S.surface, border: `0.5px solid ${S.border}`, borderRadius: 10, padding: '12px 14px' }}>
            <div style={{ fontSize: 24, fontWeight: 500, color: m.color, marginBottom: 2, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 16 }}>{m.icon}</span>
              {m.val}
            </div>
            <div style={{ fontSize: 11, color: S.muted }}>{m.lbl}</div>
          </div>
        ))}
      </div>

      {mensajes.length > 0 && (
        <div style={{ padding: '0 18px', marginBottom: 8 }}>
          <div style={{ fontSize: 10, color: S.muted, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 8 }}>Javi dice</div>
          {mensajes.slice(0, 3).map(m => (
            <div key={m.id} style={{
              background: m.tipo === 'respuesta' ? '#0D1F3C' : m.tipo === 'importante' ? '#1C1500' : S.surface,
              border: `0.5px solid ${m.tipo === 'respuesta' ? '#1D4ED8' : m.tipo === 'importante' ? '#B45309' : S.border}`,
              borderRadius: 10, padding: '10px 13px', marginBottom: 6
            }}>
              {m.pregunta && (
                <div style={{ fontSize: 11, color: S.muted, marginBottom: 4, fontStyle: 'italic' }}>"{m.pregunta}"</div>
              )}
              <div style={{ fontSize: 10, color: m.tipo === 'respuesta' ? S.blue : m.tipo === 'importante' ? S.amber : S.muted, fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 3 }}>
                {m.tipo === 'respuesta' ? 'Javi responde' : m.tipo === 'importante' ? 'Javi' : m.tipo === 'sistema' ? 'Sistema' : 'Clínico'} · {m.hora}
              </div>
              <div style={{ fontSize: 13, color: m.tipo === 'sistema' ? S.muted : '#CBD5E1', lineHeight: 1.5 }}>{m.texto}</div>
            </div>
          ))}
        </div>
      )}

      {pacientes.length > 0 && (
        <div style={{ padding: '0 18px', marginBottom: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <div style={{ fontSize: 10, color: S.muted, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Pacientes detectados</div>
          </div>
          {pacientes.slice(0, 3).map((p, i) => (
            <div key={p.id || i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', borderBottom: `0.5px solid ${S.border}` }}>
              <div style={{ width: 32, height: 32, borderRadius: 8, background: S.blueDark, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 600, color: S.text, flexShrink: 0 }}>
                {p.cama || i + 1}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: S.text }}>{p.nombre || 'Paciente ' + (i + 1)}</div>
                <div style={{ fontSize: 11, color: S.muted, marginTop: 1 }}>{p.dx || 'Sin diagnóstico asignado'}</div>
              </div>
              <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 99, background: p.estado === 'critico' ? 'rgba(239,68,68,0.1)' : p.estado === 'pendiente' ? 'rgba(245,158,11,0.1)' : 'rgba(34,197,94,0.1)', color: p.estado === 'critico' ? S.red : p.estado === 'pendiente' ? S.amber : S.green, border: `0.5px solid ${p.estado === 'critico' ? 'rgba(239,68,68,0.2)' : p.estado === 'pendiente' ? 'rgba(245,158,11,0.2)' : 'rgba(34,197,94,0.2)'}` }}>
                {p.estado || 'estable'}
              </span>
            </div>
          ))}
        </div>
      )}

      <div style={{ flex: 1 }} />

      <div style={{ padding: '12px 18px', borderTop: `0.5px solid ${S.border}`, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={consultaTexto}
            onChange={e => setConsultaTexto(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && consultarJavi(consultaTexto)}
            placeholder="Preguntá algo a Javi..."
            style={{ flex: 1, background: S.surface, border: `0.5px solid ${S.border}`, borderRadius: 8, padding: '10px 12px', fontSize: 13, color: S.text, outline: 'none' }}
          />
          <button
            onClick={() => consultaTexto.trim() ? consultarJavi(consultaTexto) : grabarConsulta()}
            disabled={respondiendo}
            style={{ width: 40, height: 40, borderRadius: 10, background: consultaActiva ? 'rgba(239,68,68,0.15)' : S.blue, border: 'none', color: '#fff', cursor: 'pointer', fontSize: 16, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {consultaActiva ? '⏹' : consultaTexto.trim() ? '↑' : '🎙'}
          </button>
        </div>
      </div>

      <div style={{ background: S.surface, borderTop: `0.5px solid ${S.border}`, padding: '10px 0 24px', display: 'flex', justifyContent: 'space-around', alignItems: 'center' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, cursor: 'pointer' }} onClick={() => setTab('inicio')}>
          <span style={{ fontSize: 20 }}>🏠</span>
          <span style={{ fontSize: 10, color: tab === 'inicio' ? S.blue : S.muted }}>Inicio</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, cursor: 'pointer' }} onClick={() => setTab('pacientes')}>
          <span style={{ fontSize: 20 }}>👥</span>
          <span style={{ fontSize: 10, color: tab === 'pacientes' ? S.blue : S.muted }}>Pacientes</span>
        </div>
        <div style={{ marginTop: -14 }}>
          <button
            onClick={grabando ? detenerGrabacion : iniciarGrabacion}
            style={{ width: 52, height: 52, borderRadius: '50%', background: grabando ? S.red : S.blue, border: 'none', color: '#fff', cursor: 'pointer', fontSize: 22, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {grabando ? '⏸' : '🎙'}
          </button>
        </div>
        <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, cursor: 'pointer' }} onClick={() => setTab('pendientes')}>
          {pendientes > 0 && <div style={{ position: 'absolute', top: -4, right: -4, width: 14, height: 14, borderRadius: '50%', background: S.red, color: '#fff', fontSize: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600 }}>{pendientes}</div>}
          <span style={{ fontSize: 20 }}>⏰</span>
          <span style={{ fontSize: 10, color: tab === 'pendientes' ? S.blue : S.muted }}>Pendientes</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, cursor: 'pointer' }} onClick={() => setTab('mas')}>
          <span style={{ fontSize: 20 }}>···</span>
          <span style={{ fontSize: 10, color: tab === 'mas' ? S.blue : S.muted }}>Más</span>
        </div>
      </div>

      <style>{`
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.3} }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        input::placeholder { color: #8B949E; }
      `}</style>
    </div>
  )
}
