import clsx from 'clsx';
import React, { useState } from 'react';
import { MdVisibility, MdVisibilityOff } from 'react-icons/md';
import { useEnv } from '@/context/EnvContext';
import { useTranslation, type TranslationFunc } from '@/hooks/useTranslation';
import { useSettingsStore } from '@/store/settingsStore';
import { eventDispatcher } from '@/utils/event';
import { FileSyncError } from '@/services/sync/file/provider';
import { createS3Provider } from '@/services/sync/providers/s3/S3Provider';
import { clearS3Credentials, saveS3Credentials } from '@/services/sync/providers/s3/credentials';
import { getPrivateS3Identity, isPrivateS3Mode } from '@/services/sync/privateS3';
import { isTauriAppPlatform } from '@/services/environment';
import { SectionTitle } from '../primitives';
import FileSyncForm from './FileSyncForm';
import { persistCloudProviderEnabled } from './cloudSync';

/**
 * Translate a connection-probe failure into a user-facing string. Each branch
 * is a literal `_('...')` call so the i18next-scanner picks the keys up.
 */
const formatConnectError = (_: TranslationFunc, e: unknown): string => {
  if (e instanceof FileSyncError) {
    switch (e.code) {
      case 'AUTH_FAILED':
        return _('Authentication failed');
      case 'NOT_FOUND':
        return _('Bucket not found');
      case 'NETWORK':
        return _('Network error');
    }
    if (typeof e.status === 'number') {
      return _('Unexpected server response (status {{status}})', { status: e.status });
    }
  }
  return _('Network error');
};

/**
 * S3-compatible provider panel, embedded in the Integrations S3 sub-page
 * (which owns the header). Same two states as {@link WebDAVForm}:
 *
 * - **Active** (`s3.enabled`): the shared {@link FileSyncForm} sync controls +
 *   a Disconnect button.
 * - **Inactive**: the endpoint/bucket/credentials form (pre-filled from saved
 *   settings, so a previously-configured bucket reconnects in one click).
 *   Connect probes the bucket with one signed listing — wrong keys surface as
 *   an auth failure, a wrong bucket as not-found — then turns S3 on. Every
 *   other provider is left exactly as it was (#5062).
 */
const S3Form: React.FC = () => {
  const _ = useTranslation();
  const { settings, setSettings, saveSettings } = useSettingsStore();
  const { envConfig } = useEnv();

  const stored = settings.s3;
  const isActive = !!stored?.enabled;
  const useSecureStorage = isPrivateS3Mode() || isTauriAppPlatform();

  const [endpoint, setEndpoint] = useState(stored?.endpoint || '');
  const [region, setRegion] = useState(stored?.region || 'auto');
  const [bucket, setBucket] = useState(stored?.bucket || '');
  const [accessKeyId, setAccessKeyId] = useState(stored?.accessKeyId || '');
  const [secretAccessKey, setSecretAccessKey] = useState(stored?.secretAccessKey || '');
  const [isConnecting, setIsConnecting] = useState(false);
  const [showSecret, setShowSecret] = useState(false);

  const hasDraftKeys = !!(accessKeyId && secretAccessKey);
  const canSubmit = !!(
    endpoint &&
    bucket &&
    (hasDraftKeys || (useSecureStorage && stored?.credentialRef))
  );

  const handleConnect = async () => {
    if (!canSubmit) return;
    setIsConnecting(true);
    const draft = {
      endpoint: endpoint.trim(),
      region: region.trim() || 'auto',
      bucket: bucket.trim(),
      ...(hasDraftKeys
        ? { accessKeyId: accessKeyId.trim(), secretAccessKey: secretAccessKey.trim() }
        : { credentialRef: stored?.credentialRef }),
    };
    let newCredentialRef: string | undefined;
    const previous = useSettingsStore.getState().settings;
    if (isPrivateS3Mode()) {
      const nextSpace = getPrivateS3Identity({
        ...previous,
        s3: { ...previous.s3, ...draft, enabled: true },
      });
      const previousSpace = getPrivateS3Identity({
        ...previous,
        s3: { ...previous.s3, enabled: true },
      });
      if (
        !nextSpace ||
        (previous.s3.endpoint && previous.s3.bucket && previousSpace !== nextSpace)
      ) {
        eventDispatcher.dispatch('toast', {
          type: 'error',
          message: !nextSpace
            ? _('An HTTPS S3 endpoint and bucket are required.')
            : _('Use a separate library to connect a different S3 space.'),
        });
        setIsConnecting(false);
        return;
      }
    }
    try {
      // One signed listing under the sync namespace validates endpoint,
      // bucket, and keys in a single round-trip (empty result included).
      await createS3Provider(draft).list('/Readest');
      newCredentialRef =
        useSecureStorage && hasDraftKeys
          ? await saveS3Credentials({
              accessKeyId: accessKeyId.trim(),
              secretAccessKey: secretAccessKey.trim(),
            })
          : undefined;
      const credentialRef = newCredentialRef ?? stored?.credentialRef;
      await persistCloudProviderEnabled(envConfig, 's3', true, (s) => {
        const next = {
          ...s,
          s3: {
            ...s.s3,
            endpoint: draft.endpoint,
            region: draft.region,
            bucket: draft.bucket,
            credentialRef,
          },
        };
        if (useSecureStorage) {
          delete next.s3.accessKeyId;
          delete next.s3.secretAccessKey;
        } else {
          next.s3.accessKeyId = accessKeyId.trim();
          next.s3.secretAccessKey = secretAccessKey.trim();
          delete next.s3.credentialRef;
        }
        return next;
      });
      if (useSecureStorage) {
        setAccessKeyId('');
        setSecretAccessKey('');
      }
      if (isPrivateS3Mode()) window.dispatchEvent(new Event('private-s3-configured'));
      if (newCredentialRef && stored?.credentialRef) {
        void clearS3Credentials(stored.credentialRef).catch(() => {});
      }
      eventDispatcher.dispatch('toast', { type: 'info', message: _('Connected') });
    } catch (e) {
      setSettings({ ...useSettingsStore.getState().settings, s3: previous.s3 });
      if (newCredentialRef) void clearS3Credentials(newCredentialRef).catch(() => {});
      eventDispatcher.dispatch('toast', {
        type: 'error',
        message: `${_('Failed to connect')}: ${formatConnectError(_, e)}`,
      });
    } finally {
      setIsConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    // Switch S3 off only — other providers keep syncing. Credentials stay so
    // a later reconnect is one click.
    await persistCloudProviderEnabled(envConfig, 's3', false);
    setShowSecret(false);
    eventDispatcher.dispatch('toast', { type: 'info', message: _('Disconnected') });
  };

  const persistS3 = async (patch: Partial<typeof stored>) => {
    const latest = useSettingsStore.getState().settings;
    const next = { ...latest, s3: { ...latest.s3, ...patch } };
    setSettings(next);
    await saveSettings(envConfig, next);
  };

  if (isActive) {
    return (
      <div className='space-y-5'>
        <FileSyncForm kind='s3' stored={stored} persist={persistS3} />

        <div className='flex justify-end'>
          <button
            type='button'
            onClick={handleDisconnect}
            className={clsx(
              'eink-bordered',
              'h-10 rounded-lg px-4 text-sm font-medium',
              'text-error hover:bg-error/10',
              'transition-colors duration-150',
              'focus-visible:ring-error/40 focus-visible:outline-hidden focus-visible:ring-2',
            )}
          >
            {_('Disconnect')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <form
      className='space-y-4'
      onSubmit={(e) => {
        e.preventDefault();
        handleConnect();
      }}
    >
      <div className='space-y-1.5'>
        <SectionTitle as='label' htmlFor='s3-endpoint' className='block'>
          {_('Endpoint')}
        </SectionTitle>
        <input
          id='s3-endpoint'
          type='text'
          placeholder='https://<account-id>.r2.cloudflarestorage.com'
          className='input eink-bordered h-11 w-full text-sm focus:outline-hidden'
          spellCheck='false'
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
        />
      </div>

      <div className='space-y-1.5'>
        <SectionTitle as='label' htmlFor='s3-bucket' className='block'>
          {_('Bucket')}
        </SectionTitle>
        <input
          id='s3-bucket'
          type='text'
          placeholder='readest'
          className='input eink-bordered h-11 w-full text-sm focus:outline-hidden'
          spellCheck='false'
          value={bucket}
          onChange={(e) => setBucket(e.target.value)}
        />
      </div>

      <div className='space-y-1.5'>
        <SectionTitle as='label' htmlFor='s3-region' className='block'>
          {_('Region')}
        </SectionTitle>
        <input
          id='s3-region'
          type='text'
          placeholder='auto'
          className='input eink-bordered h-11 w-full text-sm focus:outline-hidden'
          spellCheck='false'
          value={region}
          onChange={(e) => setRegion(e.target.value)}
        />
      </div>

      <div className='space-y-1.5'>
        <SectionTitle as='label' htmlFor='s3-access-key-id' className='block'>
          {_('Access Key ID')}
        </SectionTitle>
        <input
          id='s3-access-key-id'
          type='text'
          placeholder={_('Your Access Key ID')}
          className='input eink-bordered h-11 w-full text-sm focus:outline-hidden'
          spellCheck='false'
          value={accessKeyId}
          onChange={(e) => setAccessKeyId(e.target.value)}
          autoComplete='off'
        />
      </div>

      <div className='space-y-1.5'>
        <SectionTitle as='label' htmlFor='s3-secret-access-key' className='block'>
          {_('Secret Access Key')}
        </SectionTitle>
        <div className='relative'>
          <input
            id='s3-secret-access-key'
            type={showSecret ? 'text' : 'password'}
            placeholder={_('Your Secret Access Key')}
            className='input eink-bordered h-11 w-full pe-11 text-sm focus:outline-hidden'
            value={secretAccessKey}
            onChange={(e) => setSecretAccessKey(e.target.value)}
            autoComplete='off'
          />
          <button
            type='button'
            onClick={() => setShowSecret((v) => !v)}
            className={clsx(
              'absolute end-2 top-1/2 -translate-y-1/2',
              'flex h-8 w-8 items-center justify-center rounded-sm',
              'text-base-content/60 hover:text-base-content',
              'hover:bg-base-200/60 transition-colors duration-150',
              'focus-visible:ring-base-content/15 focus-visible:outline-hidden focus-visible:ring-2',
            )}
            aria-label={showSecret ? _('Hide password') : _('Show password')}
            title={showSecret ? _('Hide password') : _('Show password')}
            tabIndex={-1}
          >
            {showSecret ? (
              <MdVisibilityOff className='h-4 w-4' />
            ) : (
              <MdVisibility className='h-4 w-4' />
            )}
          </button>
        </div>
      </div>

      <div className='flex justify-end pt-1'>
        <button
          type='submit'
          disabled={isConnecting || !canSubmit}
          className={clsx(
            'btn btn-contrast',
            'h-10 min-h-10 rounded-lg border-0 px-5 text-sm font-medium',
            'focus-visible:ring-base-content/40 focus-visible:outline-hidden focus-visible:ring-2',
            isConnecting && 'opacity-60',
          )}
        >
          {isConnecting ? <span className='loading loading-spinner loading-sm' /> : _('Connect')}
        </button>
      </div>
    </form>
  );
};

export default S3Form;
