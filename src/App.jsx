import { useState, useRef, useEffect, useCallback } from 'react'
import { MicVAD } from '@ricky0123/vad-web'

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
  const [consultaTexto, setConsultaTexto] = useState('')
  const [respondiendo, setRespondiendo] = useState(false)
  const [consultaActiva, setConsultaActiva] = useState(false)
  const [escuchando, setEscuchando] = useState(false)
  const [modoConsulta, setModoConsulta] = useState(false)

  const vadRef = useRef(null)
  const timerRef = useRef(null)
  const guardiaId = useRef('G' + Date.now().toString(36).toUpperCase())
  const grabandoRef = useRef(false)
  const pacientesRef = useRef([])
  const modoConsultaRef = useRef(false)
  const bufferAudioRef = useRef([])

  useEffect(() => { pacientesRef.current = pacientes }, [pacientes])
  useEffect(() => { modoConsultaRef.current = modoConsulta }, [modoConsulta])

  useEffect(() => {
    const guardiaGuardada = localStorage.getItem('javi_guardia')
    if (guardiaGuardada) {
      try {
        const g = JSON.parse(guardiaGuardada)
        setSegundos(g.segundos || 0)
        setPacientes(g.pacientes || [])
        setMensajes(g.mensajes || [])
        setPendientes(g.pendientes || 0)
        setAlertas(g.alertas || 0)
        setEvoluciones(g.evoluciones || 0)
        guardiaId.current = g.id || guardiaId.current
      } catch {}
    }
  }, [])

  useEffect(() => {
    localStorage.setItem('javi_guardia', JSON.stringify({
      id: guardiaId.current,
      segundos, pacientes, mensajes, pendientes, alertas, evoluciones
    }))
  }, [segundos, pacientes, mensajes, pendientes, alertas, evoluciones])

  useEffect(() => {
    if (grabando) {
      setMensajes(prev => {
        if (prev.some(m => m.tipo === 'sistema')) return prev
        return [{
          id: Date.now(),
          tipo: 'sistema',
          texto: 'Estoy escuchando tu guardia. Hablá con normalidad.',
          hora: new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })
        }, ...prev]
      })
    }
  }, [grabando])

  const hablarConVoz = useCallback((texto) => {
    if (!window.speechSynthesis) return
    window.speechSynthesis.cancel()
    const u = new SpeechSynthesisUtterance(texto)
    u.lang = 'es-AR'
    u.rate = 0.92
    u.pitch = 1.05
    const voces = window.speechSynthesis.getVoices()
    const voz = voces.find(v => v.lang.startsWith('es') && v.name.includes('Female'))
      || voces.find(v => v.lang.startsWith('es'))
      || voces[0]
    if (voz) u.voice = voz
    window.speechSynthesis.speak(u)
  }, [])

  const procesarSegmento = useCallback(async (audioData, esConsulta = false) => {
    try {
      const float32 = audioData instanceof Float32Array ? audioData : new Float32Array(audioData)
      const wavBlob = float32ToWav(float32, 16000)
      if (wavBlob.size < 1000) return

      const fd = new FormData()
      fd.append('audio', wavBlob, 'segmento.wav')
      fd.append('guardia_id', guardiaId.current)
      fd.append('timestamp', new Date().toISOString())

      const resAudio = await fetch(`${API}/javi/audio`, { method: 'POST', body: fd })
      if (!resAudio.ok) return
      const audioDataRes = await resAudio.json()
      const transcripcion = audioDataRes.transcripcion?.trim()
      if (!transcripcion || transcripcion.length < 3) return

      console.log('JAVI transcripción:', transcripcion)

      const esWakeWord = /\bjavi\b/i.test(transcripcion)
      if (esWakeWord || esConsulta || modoConsultaRef.current) {
        const pregunta = transcripcion.replace(/\bjavi[,\s]*/i, '').trim()
        if (pregunta.length > 3) await consultarJaviDirecto(pregunta)
        return
      }

      const resProcesar = await fetch(`${API}/javi/procesar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transcripcion,
          guardia_id: guardiaId.current,
          pacientes_actuales: pacientesRef.current,
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
            mapa[p.id] = mapa[p.id] ? { ...mapa[p.id], ...p } : p
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
        if (data.tipo_mensaje === 'importante') hablarConVoz(data.mensaje_javi)
      }

      if (data.nuevos_pendientes) setPendientes(prev => prev + data.nuevos_pendientes)
      if (data.nuevas_alertas) setAlertas(prev => prev + data.nuevas_alertas)

    } catch (e) {
      console.error('Error procesando segmento:', e)
    }
  }, [hablarConVoz])

  const consultarJaviDirecto = useCallback(async (pregunta) => {
    if (respondiendo) return
    setRespondiendo(true)
    hablarConVoz('Un momento...')
    try {
      const res = await fetch(`${API}/javi/consulta`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pregunta,
          guardia_id: guardiaId.current,
          pacientes: pacientesRef.current,
        })
      })
      const data = await res.json()
      if (data.respuesta) {
        setMensajes(prev => [{
          id: Date.now(),
          tipo: 'respuesta',
          pregunta,
          texto: data.respuesta,
          hora: new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })
        }, ...prev].slice(0, 10))
        hablarConVoz(data.respuesta)
      }
    } catch (e) {
      console.error('Error consultando:', e)
    }
    setRespondiendo(false)
  }, [respondiendo, hablarConVoz])

  function float32ToWav(samples, sampleRate) {
    const buffer = new ArrayBuffer(44 + samples.length * 2)
    const view = new DataView(buffer)
    const writeStr = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)) }
    writeStr(0, 'RIFF')
    view.setUint32(4, 36 + samples.length * 2, true)
    writeStr(8, 'WAVE')
    writeStr(12, 'fmt ')
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, 1, true)
    view.setUint32(24, sampleRate, true)
    view.setUint32(28, sampleRate * 2, true)
    view.setUint16(32, 2, true)
    view.setUint16(34, 16, true)
    writeStr(36, 'data')
    view.setUint32(40, samples.length * 2, true)
    const vol = 0x7FFF
    for (let i = 0; i < samples.length; i++) {
      view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * vol, true)
    }
    return new Blob([buffer], { type: 'audio/wav' })
  }

  const iniciarGrabacion = useCallback(async () => {
    try {
      grabandoRef.current = true
      setGrabando(true)
      timerRef.current = setInterval(() => setSegundos(s => s + 1), 1000)

      const vad = await MicVAD.new({
        model: 'v5',
        onSpeechStart: () => {
          console.log('JAVI VAD: voz detectada')
          setEscuchando(true)
        },
        onSpeechEnd: async (audio) => {
          console.log('JAVI VAD: voz terminada, samples:', audio.length)
          setEscuchando(false)
          if (grabandoRef.current) await procesarSegmento(audio)
        },
        onVADMisfire: () => {
          console.log('JAVI VAD: falso positivo descartado')
          setEscuchando(false)
        },
        positiveSpeechThreshold: 0.8,
        negativeSpeechThreshold: 0.3,
        minSpeechFrames: 5,
      })

      await vad.start()
      vadRef.current = vad

    } catch (e) {
      console.error('Error iniciando VAD:', e)
      grabandoRef.current = false
      setGrabando(false)
      clearInterval(timerRef.current)
      alert('Error al iniciar: ' + e.message)
    }
  }, [procesarSegmento])

  const detenerGrabacion = useCallback(() => {
    grabandoRef.current = false
    if (vadRef.current) {
      vadRef.current.pause()
      vadRef.current = null
    }
    clearInterval(timerRef.current)
    setGrabando(false)
    setEscuchando(false)
  }, [])

  const consultarPorVoz = useCallback(async () => {
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
        if (data.transcripcion) await consultarJaviDirecto(data.transcripcion)
        setConsultaActiva(false)
      }
      mr.start()
      setTimeout(() => { if (mr.state === 'recording') mr.stop() }, 8000)
    } catch (e) {
      setConsultaActiva(false)
    }
  }, [consultarJaviDirecto])

  const nuevaGuardia = () => {
    if (!window.confirm('¿Iniciás guardia nueva? Se pierden los datos actuales.')) return
    detenerGrabacion()
    localStorage.removeItem('javi_guardia')
    setSegundos(0); setPacientes([]); setMensajes([])
    setPendientes(0); setAlertas(0); setEvoluciones(0)
    guardiaId.current = 'G' + Date.now().toString(36).toUpperCase()
  }

  return (
    <div style={{ background: S.bg, minHeight: '100vh', maxWidth: 390, margin: '0 auto', display: 'flex', flexDirection: 'column', fontFamily: '-apple-system,BlinkMacSystemFont,"SF Pro Text",Inter,sans-serif' }}>
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        input::placeholder { color: #8B949E; }
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.3} }
        @keyframes pulse { 0%{transform:scale(1);opacity:0.6} 100%{transform:scale(1.5);opacity:0} }
      `}</style>

      <div style={{ padding: '14px 18px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 11, color: S.dim }}>
          {new Date().toLocaleDateString('es-AR', { weekday: 'short', day: '2-digit', month: 'short' })}
        </span>
        <button onClick={nuevaGuardia} style={{ background: 'none', border: 'none', color: S.muted, cursor: 'pointer', fontSize: 12 }}>
          nueva guardia
        </button>
      </div>

      <div style={{ padding: '14px 18px 12px', borderBottom: `0.5px solid ${S.border}` }}>
        <div style={{ fontSize: 10, color: S.dim, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 4 }}>Guardia activa</div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontSize: 22, fontWeight: 500, color: S.text, letterSpacing: '0.01em' }}>JAVI</div>
          {escuchando && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: S.blue }}>
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: S.blue, animation: 'blink 0.8s infinite' }} />
              escuchando
            </div>
          )}
        </div>
        <div style={{ fontSize: 12, color: S.blue, marginTop: 2 }}>Tu compañero de guardia · 24hs con vos</div>
        <div style={{ marginTop: 12, background: S.surface, border: `0.5px solid ${S.border}`, borderRadius: 8, padding: '9px 13px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ width: 7, height: 7, borderRadius: '50%', background: grabando ? S.green : S.dim, animation: grabando ? 'blink 1.5s infinite' : 'none' }} />
            <span style={{ fontSize: 13, color: grabando ? S.green : S.muted, fontWeight: 500 }}>
              {grabando ? (escuchando ? 'Detectando voz...' : 'En guardia') : 'Inactivo'}
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
              <span style={{ fontSize: 16 }}>{m.icon}</span>{m.val}
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
              {m.pregunta && <div style={{ fontSize: 11, color: S.muted, marginBottom: 4, fontStyle: 'italic' }}>"{m.pregunta}"</div>}
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
          <div style={{ fontSize: 10, color: S.muted, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 8 }}>Pacientes detectados</div>
          {pacientes.slice(0, 4).map((p, i) => (
            <div key={p.id || i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderBottom: `0.5px solid ${S.border}` }}>
              <div style={{ width: 32, height: 32, borderRadius: 8, background: S.blueDark, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 600, color: S.text, flexShrink: 0 }}>
                {p.cama || '?'}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: S.text }}>{p.nombre || 'Paciente detectado'}</div>
                <div style={{ fontSize: 11, color: S.muted, marginTop: 1 }}>{p.dx || '—'}</div>
              </div>
              <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 99, background: p.estado === 'critico' ? 'rgba(239,68,68,0.1)' : p.estado === 'pendiente' ? 'rgba(245,158,11,0.1)' : 'rgba(34,197,94,0.1)', color: p.estado === 'critico' ? S.red : p.estado === 'pendiente' ? S.amber : S.green, border: `0.5px solid ${p.estado === 'critico' ? 'rgba(239,68,68,0.2)' : p.estado === 'pendiente' ? 'rgba(245,158,11,0.2)' : 'rgba(34,197,94,0.2)'}` }}>
                {p.estado || 'estable'}
              </span>
            </div>
          ))}
        </div>
      )}

      <div style={{ flex: 1 }} />

      <div style={{ padding: '10px 18px 8px', borderTop: `0.5px solid ${S.border}` }}>
        <div style={{ fontSize: 11, color: S.dim, marginBottom: 6, textAlign: 'center' }}>
          {grabando ? 'Decí "Javi" para hacer una consulta' : 'Iniciá la guardia para que Javi te escuche'}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={consultaTexto}
            onChange={e => setConsultaTexto(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && consultaTexto.trim() && consultarJaviDirecto(consultaTexto).then(() => setConsultaTexto(''))}
            placeholder="Escribí una consulta a Javi..."
            style={{ flex: 1, background: S.surface, border: `0.5px solid ${S.border}`, borderRadius: 8, padding: '10px 12px', fontSize: 13, color: S.text, outline: 'none' }}
          />
          <button
            onClick={() => consultaTexto.trim() ? consultarJaviDirecto(consultaTexto).then(() => setConsultaTexto('')) : consultarPorVoz()}
            disabled={respondiendo}
            style={{ width: 40, height: 40, borderRadius: 10, background: consultaActiva ? 'rgba(239,68,68,0.2)' : S.blue, border: 'none', color: '#fff', cursor: 'pointer', fontSize: 16, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {consultaActiva ? '⏹' : consultaTexto.trim() ? '↑' : '🎙'}
          </button>
        </div>
      </div>

      <div style={{ background: S.surface, borderTop: `0.5px solid ${S.border}`, padding: '10px 0 24px', display: 'flex', justifyContent: 'space-around', alignItems: 'center' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
          <span style={{ fontSize: 20 }}>🏠</span>
          <span style={{ fontSize: 10, color: S.blue }}>Inicio</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
          <span style={{ fontSize: 20 }}>👥</span>
          <span style={{ fontSize: 10, color: S.muted }}>Pacientes</span>
        </div>
        <div style={{ marginTop: -14 }}>
          <button
            onClick={grabando ? detenerGrabacion : iniciarGrabacion}
            style={{ width: 56, height: 56, borderRadius: '50%', background: grabando ? S.red : S.blue, border: 'none', color: '#fff', cursor: 'pointer', fontSize: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
            {grabando ? '⏸' : '🎙'}
            {escuchando && (
              <div style={{ position: 'absolute', inset: -4, borderRadius: '50%', border: `2px solid ${S.blue}`, animation: 'pulse 1s ease-out infinite', pointerEvents: 'none' }} />
            )}
          </button>
        </div>
        <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
          {pendientes > 0 && <div style={{ position: 'absolute', top: -4, right: -4, width: 14, height: 14, borderRadius: '50%', background: S.red, color: '#fff', fontSize: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600 }}>{pendientes}</div>}
          <span style={{ fontSize: 20 }}>⏰</span>
          <span style={{ fontSize: 10, color: S.muted }}>Pendientes</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
          <span style={{ fontSize: 20 }}>···</span>
          <span style={{ fontSize: 10, color: S.muted }}>Más</span>
        </div>
      </div>
    </div>
  )
}
