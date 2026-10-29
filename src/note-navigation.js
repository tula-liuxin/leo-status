export function assertNavigationReady({pendingUploads=0,recording=false,failedUploads=0,saving=false,submitting=false}={}){
 if(recording)throw new Error('请先结束录音，并等待录音上传完成。')
 if(pendingUploads)throw new Error('附件正在上传，请等待上传完成再切换。')
 if(failedUploads)throw new Error('有附件上传失败，请先重试或移除失败附件。')
 if(saving)throw new Error('草稿正在保存，请等待完成后再切换。')
 if(submitting)throw new Error('笔记正在提交，请等待完成后再切换。')
}
