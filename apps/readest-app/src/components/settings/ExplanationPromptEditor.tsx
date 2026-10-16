import React, { useId, useState } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useTranslation } from '@/hooks/useTranslation';
import { useSettingsStore } from '@/store/settingsStore';
import {
  DEFAULT_EXPLANATION_PROMPT_TEMPLATE,
  getExplanationPromptTemplate,
  isValidExplanationPromptTemplate,
} from '@/app/reader/utils/explanationPrompt';
import { BoxedList, SettingLabel, Tips } from './primitives';
import SubPageHeader from './SubPageHeader';

const ExplanationPromptEditor: React.FC<{ onBack: () => void }> = ({ onBack }) => {
  const _ = useTranslation();
  const { envConfig } = useEnv();
  const [draft, setDraft] = useState(() =>
    getExplanationPromptTemplate(
      useSettingsStore.getState().settings.globalReadSettings?.explanationPromptTemplate,
    ),
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const id = useId();
  const errorId = `${id}-error`;
  const invalid = !isValidExplanationPromptTemplate(draft);

  const handleSave = async () => {
    if (invalid || saving) return;
    setSaving(true);
    setSaveError(false);
    const store = useSettingsStore.getState();
    const next = {
      ...store.settings,
      globalReadSettings: {
        ...store.settings.globalReadSettings,
        explanationPromptTemplate: draft,
      },
    };
    try {
      await store.saveSettings(envConfig, next);
      const current = useSettingsStore.getState().settings;
      store.setSettings({
        ...current,
        globalReadSettings: { ...current.globalReadSettings, explanationPromptTemplate: draft },
      });
      onBack();
    } catch {
      setSaveError(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className='my-4 w-full space-y-6'>
      <SubPageHeader
        parentLabel={_('Behavior')}
        currentLabel={_('Explanation Prompt')}
        description={_('One prompt template for all books on this device.')}
        onBack={onBack}
      />
      <BoxedList>
        <div className='flex flex-col gap-2 py-3 pe-4'>
          <SettingLabel as='label' htmlFor={id}>
            {_('Prompt Template')}
          </SettingLabel>
          <textarea
            id={id}
            className='textarea eink-bordered h-64 w-full text-base sm:text-sm'
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setSaveError(false);
            }}
            disabled={saving}
            spellCheck={false}
            aria-invalid={invalid}
            aria-describedby={invalid || saveError ? errorId : undefined}
          />
          {(invalid || saveError) && (
            <p id={errorId} role='alert' className='text-error text-sm'>
              {invalid
                ? _('Include {{placeholder}} in the template.', { placeholder: '{{selection}}' })
                : _('Could not save the prompt template. Please try again.')}
            </p>
          )}
        </div>
      </BoxedList>
      <Tips>
        <li>
          <code>{'{{selection}}'}</code> — {_('The complete selected text.')}
        </li>
        <li>
          <code>{'{{source}}'}</code> — {_('Available title, author, chapter, location and link.')}
        </li>
        <li>{_('Only these two placeholders are replaced. No extra instructions are added.')}</li>
      </Tips>
      <div className='flex justify-end gap-2 px-4'>
        <button
          type='button'
          className='btn btn-ghost btn-sm eink-bordered'
          disabled={saving}
          onClick={() => {
            setDraft(DEFAULT_EXPLANATION_PROMPT_TEMPLATE);
            setSaveError(false);
          }}
        >
          {_('Reset to Default')}
        </button>
        <button
          type='button'
          className='btn btn-contrast btn-sm'
          disabled={invalid || saving}
          onClick={() => void handleSave()}
        >
          {saving ? _('Saving...') : _('Save')}
        </button>
      </div>
    </div>
  );
};

export default ExplanationPromptEditor;
