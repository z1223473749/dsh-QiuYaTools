import React from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { PROJECT_REPOSITORY, PROJECT_ISSUES } from '../project.ts'
import { COLOR_ICON_DATA_URL } from './brand-assets.ts'
import { ProjectIcon as AboutIcon } from './project-icon.tsx'
import css from './about.css'

export function AboutPanel(_props: { version: string; ctx: Context }) {
  return <div className="qyt-about">
    <style>{css}</style>
    <header className="qyt-about-hero">
      <div className="qyt-about-sky" aria-hidden="true"><span className="qyt-about-spark qyt-about-spark-one"/><span className="qyt-about-spark qyt-about-spark-two"/><span className="qyt-about-dot"/></div>
      <div className="qyt-about-art"><span className="qyt-about-halo" aria-hidden="true"/><img src={COLOR_ICON_DATA_URL} width="108" height="108" alt="白发少年坐在鲸鱼上" /></div>
      <div className="qyt-about-copy"><span className="qyt-about-eyebrow">QiuYa 增强工具箱</span><h3 className="qyt-about-title">QiuYaTools<span aria-hidden="true">.</span></h3><p className="qyt-about-tagline">给 Harness 加一点顺手的小功能。</p></div>
      <div className="qyt-about-sea" aria-hidden="true"/>
    </header>
    <section className="qyt-about-story"><h4>从日常的小事开始</h4><p>从一次粘贴，到多个并行会话，把常用操作做得更顺手。</p><div className="qyt-about-features"><span>长文本附件</span><span>会话分窗</span><span>批量归档</span><span>计划批注</span></div></section>
    <nav className="qyt-about-links" aria-label="项目与反馈">
      {PROJECT_REPOSITORY && <a className="qyt-about-link" href={PROJECT_REPOSITORY} target="_blank" rel="noopener noreferrer"><span className="qyt-about-link-icon"><AboutIcon kind="github"/></span><span className="qyt-about-link-copy"><strong>GitHub 开源</strong><small>看看源码，一起完善</small></span><AboutIcon kind="arrow"/></a>}
      {PROJECT_ISSUES && <a className="qyt-about-link" href={PROJECT_ISSUES} target="_blank" rel="noopener noreferrer"><span className="qyt-about-link-icon"><AboutIcon kind="heart"/></span><span className="qyt-about-link-copy"><strong>反馈与建议</strong><small>聊聊你的新想法</small></span><AboutIcon kind="arrow"/></a>}
    </nav>
    <footer className="qyt-about-footer"><span><strong>QiuYa</strong> 制作<span className="qyt-about-footer-dot" aria-hidden="true"/>MIT 开源</span><a href="https://www.qiuya.cc" target="_blank" rel="noopener noreferrer">www.qiuya.cc <AboutIcon kind="arrow"/></a></footer>
  </div>
}
