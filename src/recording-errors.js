export function recordingErrorMessage(error) {
  if (error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError')
    return '麦克风访问被拒绝。请检查浏览器或 DSH 的麦克风权限及系统设置，也可以上传音频。'
  if (error?.name === 'NotFoundError' || error?.name === 'DevicesNotFoundError' || error?.name === 'OverconstrainedError')
    return '没有找到可用的麦克风，请检查设备连接，也可以上传音频。'
  if (error?.name === 'NotReadableError' || error?.name === 'TrackStartError')
    return '麦克风暂时无法使用，请检查设备是否被其他程序占用，也可以上传音频。'
  return '无法录音：' + (error?.message || '当前环境不支持录音') + '。也可以上传音频。'
}
