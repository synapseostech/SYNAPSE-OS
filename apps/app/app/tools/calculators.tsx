import { useMemo, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { ScreenShell } from '@/components/ui/ScreenShell'
import { TextField } from '@/components/ui/TextField'
import {
  CALCULATOR_PACK_VERSION,
  calcBmi,
  calcCrCl,
  calcDripRate,
  calcEgfrCkdEpi,
  calcIbw,
  calcWeightDose,
} from '@/lib/calculators'
import { radii, spacing, typography, makeStyles } from '@/lib/theme'

type Tab = 'bmi' | 'crcl' | 'egfr' | 'dose' | 'drip'

const TABS: { key: Tab; label: string }[] = [
  { key: 'bmi', label: 'BMI' },
  { key: 'crcl', label: 'CrCl' },
  { key: 'egfr', label: 'eGFR' },
  { key: 'dose', label: 'Dose' },
  { key: 'drip', label: 'Drip' },
]

export default function CalculatorsScreen() {
  const styles = useStyles()
  const [tab, setTab] = useState<Tab>('bmi')
  const [weight, setWeight] = useState('')
  const [height, setHeight] = useState('')
  const [age, setAge] = useState('')
  const [sex, setSex] = useState<'male' | 'female'>('female')
  const [scr, setScr] = useState('')
  const [scrUnit, setScrUnit] = useState<'umol' | 'mgdl'>('umol')
  const [mgPerKg, setMgPerKg] = useState('')
  const [dosesPerDay, setDosesPerDay] = useState('1')
  const [volume, setVolume] = useState('')
  const [timeMin, setTimeMin] = useState('')
  const [dropFactor, setDropFactor] = useState('20')

  const result = useMemo(() => {
    const w = Number(weight)
    const h = Number(height)
    const a = Number(age)
    const c = Number(scr)
    const mpk = Number(mgPerKg)
    const dpd = Number(dosesPerDay)
    const vol = Number(volume)
    const t = Number(timeMin)
    const df = Number(dropFactor)

    if (tab === 'bmi') {
      const r = calcBmi(w, h)
      return r ? `${r.bmi} — ${r.category}` : null
    }
    if (tab === 'crcl') {
      const r = calcCrCl({
        ageYears: a,
        weightKg: w,
        sex,
        serumCreatinine: c,
        unit: scrUnit,
      })
      return r != null ? `${r} mL/min (Cockcroft–Gault)` : null
    }
    if (tab === 'egfr') {
      const umol = scrUnit === 'umol' ? c : c * 88.4
      const r = calcEgfrCkdEpi({ ageYears: a, sex, serumCreatinineUmol: umol })
      return r != null ? `${r} mL/min/1.73m² (CKD-EPI 2021)` : null
    }
    if (tab === 'dose') {
      const r = calcWeightDose(w, mpk, dpd)
      if (!r) return null
      return `${r.doseMg} mg / dose · ${r.dailyMg} mg / day`
    }
    if (tab === 'drip') {
      const r = calcDripRate(vol, t, df)
      return r != null ? `${r} drops / min` : null
    }
    return null
  }, [
    tab,
    weight,
    height,
    age,
    sex,
    scr,
    scrUnit,
    mgPerKg,
    dosesPerDay,
    volume,
    timeMin,
    dropFactor,
  ])

  const ibw = useMemo(() => {
    const h = Number(height)
    const r = calcIbw(sex, h)
    return r != null ? `${r} kg IBW (Devine)` : null
  }, [height, sex])

  return (
    <ScreenShell title="Calculators">
      <Text style={styles.version}>Pack {CALCULATOR_PACK_VERSION} · not AI</Text>

      <View style={styles.tabs}>
        {TABS.map((t) => (
          <Pressable
            key={t.key}
            onPress={() => setTab(t.key)}
            style={[styles.tab, tab === t.key && styles.tabOn]}
          >
            <Text style={[styles.tabText, tab === t.key && styles.tabTextOn]}>{t.label}</Text>
          </Pressable>
        ))}
      </View>

      {(tab === 'crcl' || tab === 'egfr' || tab === 'bmi' || tab === 'dose') && (
        <View style={styles.sexRow}>
          {(['female', 'male'] as const).map((s) => (
            <Pressable
              key={s}
              onPress={() => setSex(s)}
              style={[styles.sexChip, sex === s && styles.sexChipOn]}
            >
              <Text style={[styles.sexText, sex === s && styles.sexTextOn]}>
                {s === 'female' ? 'Female' : 'Male'}
              </Text>
            </Pressable>
          ))}
        </View>
      )}

      {(tab === 'bmi' || tab === 'crcl' || tab === 'dose') && (
        <TextField
          label="Weight (kg)"
          value={weight}
          onChangeText={setWeight}
          keyboardType="decimal-pad"
        />
      )}
      {(tab === 'bmi' || tab === 'crcl' || tab === 'egfr') && (
        <TextField
          label="Height (cm)"
          value={height}
          onChangeText={setHeight}
          keyboardType="decimal-pad"
          hint={ibw ?? undefined}
        />
      )}
      {(tab === 'crcl' || tab === 'egfr') && (
        <>
          <TextField
            label="Age (years)"
            value={age}
            onChangeText={setAge}
            keyboardType="number-pad"
          />
          <View style={styles.sexRow}>
            {(['umol', 'mgdl'] as const).map((u) => (
              <Pressable
                key={u}
                onPress={() => setScrUnit(u)}
                style={[styles.sexChip, scrUnit === u && styles.sexChipOn]}
              >
                <Text style={[styles.sexText, scrUnit === u && styles.sexTextOn]}>
                  {u === 'umol' ? 'µmol/L' : 'mg/dL'}
                </Text>
              </Pressable>
            ))}
          </View>
          <TextField
            label={`Creatinine (${scrUnit === 'umol' ? 'µmol/L' : 'mg/dL'})`}
            value={scr}
            onChangeText={setScr}
            keyboardType="decimal-pad"
          />
        </>
      )}
      {tab === 'dose' && (
        <>
          <TextField
            label="mg / kg / dose"
            value={mgPerKg}
            onChangeText={setMgPerKg}
            keyboardType="decimal-pad"
          />
          <TextField
            label="Doses per day"
            value={dosesPerDay}
            onChangeText={setDosesPerDay}
            keyboardType="number-pad"
          />
        </>
      )}
      {tab === 'drip' && (
        <>
          <TextField
            label="Volume (mL)"
            value={volume}
            onChangeText={setVolume}
            keyboardType="decimal-pad"
          />
          <TextField
            label="Time (minutes)"
            value={timeMin}
            onChangeText={setTimeMin}
            keyboardType="number-pad"
          />
          <TextField
            label="Drop factor (gtt/mL)"
            value={dropFactor}
            onChangeText={setDropFactor}
            keyboardType="number-pad"
            hint="Common: 20 macro, 60 micro"
          />
        </>
      )}

      <View style={styles.resultCard}>
        <Text style={styles.resultLabel}>Result</Text>
        <Text style={styles.resultValue}>{result ?? 'Enter values'}</Text>
      </View>

      <Text style={styles.disclaimer}>
        For clinical support only. Confirm against local protocols and product information before
        dosing or dispensing.
      </Text>
    </ScreenShell>
  )
}

const useStyles = makeStyles((colors) => ({
  version: {
    ...typography.caption,
    color: colors.textMuted,
    fontFamily: 'DMSans_400Regular',
    marginBottom: spacing.md,
  },
  tabs: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginBottom: spacing.lg },
  tab: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  tabOn: { borderColor: colors.primary, backgroundColor: `${colors.primary}18` },
  tabText: {
    ...typography.caption,
    color: colors.textSecondary,
    fontFamily: 'DMSans_500Medium',
  },
  tabTextOn: { color: colors.primary },
  sexRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },
  sexChip: {
    flex: 1,
    minWidth: 0,
    paddingVertical: 10,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
  },
  sexChipOn: { borderColor: colors.primary, backgroundColor: `${colors.primary}18` },
  sexText: {
    ...typography.bodySm,
    color: colors.textSecondary,
    fontFamily: 'DMSans_500Medium',
  },
  sexTextOn: { color: colors.primary },
  resultCard: {
    marginTop: spacing.md,
    padding: spacing.lg,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  resultLabel: {
    ...typography.caption,
    color: colors.textMuted,
    fontFamily: 'DMSans_500Medium',
  },
  resultValue: {
    ...typography.h3,
    color: colors.text,
    fontFamily: 'DMSans_700Bold',
    marginTop: spacing.xs,
    flexWrap: 'wrap',
  },
  disclaimer: {
    ...typography.caption,
    color: colors.textMuted,
    fontFamily: 'DMSans_400Regular',
    marginTop: spacing.lg,
    lineHeight: 18,
  },
}))
