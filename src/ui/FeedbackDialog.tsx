import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Dialog, DialogText, Disclosure, SegmentedControl, Switch } from './kit'
import {
  ISSUES_URL,
  REPORT_LIMITS,
  buildEnvironmentBlock,
  githubIssueUrl,
  submitReport,
  type ReportKind,
  type SubmitResult,
} from '../feedback/report'

// In-app bug report / feature request form (Help menu). Posts to
// /api/report, which files a public GitHub issue; on success it links
// to that issue so the sender can follow it. Where the endpoint isn't
// available (dev server, unconfigured deploy) it offers GitHub's own form.

const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined

interface TurnstileApi {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string
  reset: (id: string) => void
  remove: (id: string) => void
}
declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

let turnstileScript: Promise<TurnstileApi> | null = null
function loadTurnstile(): Promise<TurnstileApi> {
  turnstileScript ??= new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
    s.async = true
    s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile')))
    s.onerror = () => {
      turnstileScript = null
      reject(new Error('turnstile'))
    }
    document.head.appendChild(s)
  })
  return turnstileScript
}

/** The Turnstile widget; reports its token (null when expired / failed). */
function Turnstile({ onToken, resetKey }: { onToken: (t: string | null) => void; resetKey: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const idRef = useRef<string | null>(null)
  const apiRef = useRef<TurnstileApi | null>(null)
  useEffect(() => {
    let cancelled = false
    void loadTurnstile()
      .then((api) => {
        if (cancelled || !ref.current) return
        apiRef.current = api
        idRef.current = api.render(ref.current, {
          sitekey: TURNSTILE_SITE_KEY,
          theme: 'dark',
          size: 'flexible',
          callback: (token: string) => onToken(token),
          'expired-callback': () => onToken(null),
          'error-callback': () => onToken(null),
        })
      })
      .catch(() => onToken(null))
    return () => {
      cancelled = true
      if (idRef.current && apiRef.current) apiRef.current.remove(idRef.current)
      idRef.current = null
    }
    // onToken is a state setter wrapper, stable enough for one widget
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (resetKey > 0 && idRef.current && apiRef.current) {
      onToken(null)
      apiRef.current.reset(idRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey])
  return <div ref={ref} className="min-h-[65px]" />
}

const fieldClass =
  'nf-focus w-full rounded-field border-0 bg-fill-field px-2.5 py-2 text-body text-ink outline-none placeholder:text-ink-faint'

/** Label above a control, as in the export dialog. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid gap-1.5">
      <span className="text-label text-ink-muted">{label}</span>
      {children}
    </label>
  )
}

const linkClass = 'nf-focus rounded-sm text-ink underline underline-offset-2'

/** Mirrors the server's cap on the device block (functions/api/report.ts ENV_MAX). */
const ENV_MAX = 2000

/**
 * In-app bug report / feature request (app menu). Posts to /api/report, which files a public GitHub
 * issue; on success it links to that issue. Where the endpoint isn't available (dev server,
 * unconfigured deploy) it offers GitHub's own form.
 *
 * Layout follows the other dialogs: one line on where it goes, the kind, summary and description,
 * then two folded rows: more detail (optional fields) and the device info, which is sent as written
 * and can be edited or left out.
 */
export function FeedbackDialog({
  kind: initialKind,
  isOpen,
  onClose,
}: {
  kind: ReportKind
  isOpen: boolean
  onClose: () => void
}) {
  const { t } = useTranslation('dialogs')
  const [kind, setKind] = useState<ReportKind>(initialKind)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [details, setDetails] = useState('')
  const [expected, setExpected] = useState('')
  const [website, setWebsite] = useState('') // honeypot
  const [includeEnv, setIncludeEnv] = useState(true)
  const [generatedEnv, setGeneratedEnv] = useState('')
  const [environment, setEnvironment] = useState('')
  const [token, setToken] = useState<string | null>(null)
  const [resetKey, setResetKey] = useState(0)
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<SubmitResult | null>(null)

  // A fresh form each time the dialog opens (the kind follows the menu item).
  useEffect(() => {
    if (!isOpen) return
    const env = buildEnvironmentBlock()
    setKind(initialKind)
    setTitle('')
    setDescription('')
    setDetails('')
    setExpected('')
    setWebsite('')
    setIncludeEnv(true)
    setGeneratedEnv(env)
    setEnvironment(env)
    setToken(null)
    setSending(false)
    setResult(null)
  }, [isOpen, initialKind])

  const needsToken = !!TURNSTILE_SITE_KEY
  const canSend = !sending && title.trim() !== '' && description.trim() !== '' && (!needsToken || token !== null)
  const sentEnv = includeEnv ? environment.trim() : ''

  const send = async () => {
    setSending(true)
    const r = await submitReport(
      {
        kind,
        title,
        description,
        details,
        expected: kind === 'bug' ? expected : '',
        environment: sentEnv,
        website,
      },
      token,
    )
    setSending(false)
    setResult(r)
    // a Turnstile token is single-use: get a new one for a retry
    if (r.kind !== 'ok' && needsToken) setResetKey((k) => k + 1)
  }

  const fallbackUrl = githubIssueUrl(kind, sentEnv)
  const sent = result?.kind === 'ok'
  const hasDetail = details.trim() !== '' || (kind === 'bug' && expected.trim() !== '')

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open && !sending) onClose()
      }}
      dismissable={!sending}
      width={480}
      title={sent ? t(`feedback.sentTitle.${kind}`) : t(`feedback.title.${kind}`)}
      actions={
        sent ? (
          <Button autoFocus variant="primary" onPress={onClose}>
            {t('feedback.close')}
          </Button>
        ) : (
          <>
            <a href={fallbackUrl} target="_blank" rel="noopener noreferrer" className={`${linkClass} mr-auto self-center`}>
              {t('feedback.useGitHub')}
            </a>
            <Button onPress={onClose} isDisabled={sending}>
              {t('feedback.cancel')}
            </Button>
            <Button variant="primary" onPress={() => void send()} isDisabled={!canSend}>
              {sending ? t('feedback.sending') : t(`feedback.send.${kind}`)}
            </Button>
          </>
        )
      }
    >
      {sent ? (
        <DialogText>
          {t('feedback.sentBody', { number: result.number })}{' '}
          <a href={result.url} target="_blank" rel="noopener noreferrer" className={linkClass}>
            {t('feedback.sentLink', { number: result.number })}
          </a>
        </DialogText>
      ) : (
        <>
          <DialogText>
            {t('feedback.publicNotice')}{' '}
            <a href={ISSUES_URL} target="_blank" rel="noopener noreferrer" className={linkClass}>
              {t('feedback.statusLink')}
            </a>
          </DialogText>

          <SegmentedControl<ReportKind>
            aria-label={t('feedback.kind')}
            value={kind}
            onChange={setKind}
            options={[
              { value: 'bug', label: t('feedback.kinds.bug') },
              { value: 'feature', label: t('feedback.kinds.feature') },
            ]}
          />

          <Field label={t('feedback.summary')}>
            <input
              className={fieldClass}
              value={title}
              maxLength={REPORT_LIMITS.title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t(`feedback.placeholders.${kind}.summary`)}
            />
          </Field>
          <Field label={t(`feedback.fields.${kind}.description`)}>
            <textarea
              className={`${fieldClass} min-h-24 resize-y`}
              value={description}
              maxLength={REPORT_LIMITS.text}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t(`feedback.placeholders.${kind}.description`)}
            />
          </Field>

          <Disclosure
            defaultExpanded={hasDetail}
            label={
              <span>
                {t('feedback.moreDetail')}
                <span className="text-ink-faint"> · {t('feedback.optional')}</span>
              </span>
            }
          >
            <Field label={t(`feedback.fields.${kind}.details`)}>
              <textarea
                className={`${fieldClass} min-h-20 resize-y`}
                value={details}
                maxLength={REPORT_LIMITS.text}
                onChange={(e) => setDetails(e.target.value)}
                placeholder={t(`feedback.placeholders.${kind}.details`)}
              />
            </Field>
            {kind === 'bug' && (
              <Field label={t('feedback.fields.bug.expected')}>
                <textarea
                  className={`${fieldClass} min-h-14 resize-y`}
                  value={expected}
                  maxLength={REPORT_LIMITS.text}
                  onChange={(e) => setExpected(e.target.value)}
                />
              </Field>
            )}
          </Disclosure>

          <Disclosure
            label={
              <span>
                {t('feedback.deviceInfo')}
                <span className="text-ink-faint"> · {includeEnv ? t('feedback.deviceIncluded') : t('feedback.deviceLeftOut')}</span>
              </span>
            }
          >
            <Switch isSelected={includeEnv} onChange={setIncludeEnv}>
              <span>{t('feedback.includeEnv')}</span>
            </Switch>
            {includeEnv && (
              <div className="grid gap-1.5">
                <textarea
                  aria-label={t('feedback.deviceInfo')}
                  className={`${fieldClass} min-h-32 resize-y text-caption`}
                  value={environment}
                  maxLength={ENV_MAX}
                  spellCheck={false}
                  onChange={(e) => setEnvironment(e.target.value)}
                />
                <div className="flex items-start justify-between gap-3">
                  <p className="m-0 text-caption text-ink-faint">{t('feedback.envHint')}</p>
                  {environment !== generatedEnv && (
                    <button type="button" className={`${linkClass} flex-none text-caption`} onClick={() => setEnvironment(generatedEnv)}>
                      {t('feedback.envRestore')}
                    </button>
                  )}
                </div>
              </div>
            )}
          </Disclosure>

          {/* honeypot: hidden from people, tempting to form-filling bots */}
          <input
            tabIndex={-1}
            aria-hidden
            autoComplete="off"
            className="hidden"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
            name="website"
          />

          {needsToken && <Turnstile onToken={setToken} resetKey={resetKey} />}

          {result?.kind === 'unavailable' && (
            <p className="m-0 text-ink-muted">
              {t('feedback.unavailable')}{' '}
              <a href={fallbackUrl} target="_blank" rel="noopener noreferrer" className={linkClass}>
                {t('feedback.openGitHub')}
              </a>
            </p>
          )}
          {result?.kind === 'error' && (
            <p className="m-0 text-danger">
              {t(`feedback.errors.${result.reason}`)}{' '}
              <a href={fallbackUrl} target="_blank" rel="noopener noreferrer" className={linkClass}>
                {t('feedback.openGitHub')}
              </a>
            </p>
          )}
        </>
      )}
    </Dialog>
  )
}
