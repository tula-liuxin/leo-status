import path from 'node:path'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
export function createRelay(settings,log=()=>{}) {
  const isHub=()=>settings.mode==='hub',describeError=e=>e?.message||String(e)
  const tunnel={child:null,state:'disabled',error:null,restarts:0,timer:null,stopping:false}
  function resolveSshExecutable() {
    const explicit = typeof process.env.LEO_STATUS_SSH === 'string' ? process.env.LEO_STATUS_SSH.trim() : ''
    if (explicit !== '' && existsSync(explicit)) return explicit
    if (process.platform === 'win32') {
      const root = process.env.SystemRoot || 'C:\\Windows'
      const candidates = [
        path.join(root, 'System32', 'OpenSSH', 'ssh.exe'),
        path.join(root, 'Sysnative', 'OpenSSH', 'ssh.exe'),
      ]
      for (const candidate of candidates) {
        if (existsSync(candidate)) return candidate
      }
    }
    return 'ssh'
  }

  function tunnelArgs() {
    const { sshTarget, remotePort } = settings.hub.tunnel
    const localPort = settings.hub.port
    return [
      '-N',
      '-T',
      '-o',
      'BatchMode=yes',
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=3',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-R',
      `127.0.0.1:${remotePort}:127.0.0.1:${localPort}`,
      sshTarget,
    ]
  }

  function scheduleTunnelRestart() {
    if (tunnel.stopping || !isHub() || !settings.hub.tunnel.enabled) return
    const delay = Math.min(5000 * 2 ** Math.min(tunnel.restarts, 4), 60_000)
    tunnel.restarts += 1
    if (tunnel.timer) clearTimeout(tunnel.timer)
    tunnel.timer = setTimeout(() => {
      tunnel.timer = null
      startTunnel()
    }, delay)
    tunnel.timer.unref?.()
  }

  function startTunnel() {
    if (tunnel.stopping || !isHub() || !settings.hub.tunnel.enabled) {
      tunnel.state = 'disabled'
      return
    }
    if (tunnel.child) return
    tunnel.state = 'starting'
    tunnel.error = null
    const args = tunnelArgs()
    const sshBin = resolveSshExecutable()
    log('starting ssh tunnel:', sshBin, args.join(' '))
    let child
    try {
      child = spawn(sshBin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      tunnel.state = 'stopped'
      tunnel.error = describeError(error)
      scheduleTunnelRestart()
      return
    }
    tunnel.child = child
    child.stderr?.setEncoding?.('utf8')
    child.stderr?.on?.('data', (chunk) => {
      const text = String(chunk).trim()
      if (text !== '') tunnel.error = text.slice(-400)
    })
    child.stdout?.resume?.()
    child.on('error', (error) => {
      if (tunnel.child === child) tunnel.child = null
      tunnel.state = 'stopped'
      tunnel.error = describeError(error)
      scheduleTunnelRestart()
    })
    child.on('exit', (code, signal) => {
      if (tunnel.child === child) tunnel.child = null
      if (tunnel.stopping) {
        tunnel.state = 'stopped'
        return
      }
      tunnel.state = 'stopped'
      tunnel.error = `ssh 隧道退出（code=${code}${signal ? `, signal=${signal}` : ''}）${tunnel.error ? `：${tunnel.error}` : ''}`
      log(tunnel.error)
      scheduleTunnelRestart()
    })
    const readyTimer = setTimeout(() => {
      if (tunnel.child === child && child.exitCode === null) tunnel.state = 'running'
    }, 2000)
    readyTimer.unref?.()
  }

  function stopTunnel() {
    tunnel.stopping = true
    if (tunnel.timer) {
      clearTimeout(tunnel.timer)
      tunnel.timer = null
    }
    const child = tunnel.child
    tunnel.child = null
    if (child) {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
    }
    tunnel.state = 'stopped'
  }


  return {start:startTunnel,stop:stopTunnel,status:()=>({state:tunnel.state,error:tunnel.error})}
}
