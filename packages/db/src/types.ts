export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      aefi_reports: {
        Row: {
          chw_id: string | null
          created_at: string
          created_by: string | null
          description: string
          event_type: string
          hospital_id: string | null
          id: string
          is_deleted: boolean | null
          moh_reference: string | null
          onset_date: string
          outcome: string | null
          patient_id: string
          reported_by: string | null
          severity: string
          submitted_to_moh: boolean
          tenant_id: string | null
          updated_at: string
          vaccination_date: string
          vaccine_batch: string | null
          vaccine_name: string
        }
        Insert: {
          chw_id?: string | null
          created_at?: string
          created_by?: string | null
          description: string
          event_type: string
          hospital_id?: string | null
          id?: string
          is_deleted?: boolean | null
          moh_reference?: string | null
          onset_date: string
          outcome?: string | null
          patient_id: string
          reported_by?: string | null
          severity: string
          submitted_to_moh?: boolean
          tenant_id?: string | null
          updated_at?: string
          vaccination_date: string
          vaccine_batch?: string | null
          vaccine_name: string
        }
        Update: {
          chw_id?: string | null
          created_at?: string
          created_by?: string | null
          description?: string
          event_type?: string
          hospital_id?: string | null
          id?: string
          is_deleted?: boolean | null
          moh_reference?: string | null
          onset_date?: string
          outcome?: string | null
          patient_id?: string
          reported_by?: string | null
          severity?: string
          submitted_to_moh?: boolean
          tenant_id?: string | null
          updated_at?: string
          vaccination_date?: string
          vaccine_batch?: string | null
          vaccine_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "aefi_reports_chw_id_fkey"
            columns: ["chw_id"]
            isOneToOne: false
            referencedRelation: "community_health_workers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "aefi_reports_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "aefi_reports_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "aefi_reports_reported_by_fkey"
            columns: ["reported_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "aefi_reports_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_health_chats: {
        Row: {
          content: string
          created_at: string | null
          id: string
          role: string
          session_id: string
          user_id: string
        }
        Insert: {
          content: string
          created_at?: string | null
          id?: string
          role: string
          session_id?: string
          user_id: string
        }
        Update: {
          content?: string
          created_at?: string | null
          id?: string
          role?: string
          session_id?: string
          user_id?: string
        }
        Relationships: []
      }
      allergens_catalog: {
        Row: {
          alternative_drugs: Json
          category: string
          created_at: string
          created_by: string | null
          id: string
          is_deleted: boolean | null
          name: string
          reactions: Json
          severity: string
          tenant_id: string | null
          updated_at: string
        }
        Insert: {
          alternative_drugs?: Json
          category: string
          created_at?: string
          created_by?: string | null
          id?: string
          is_deleted?: boolean | null
          name: string
          reactions?: Json
          severity: string
          tenant_id?: string | null
          updated_at?: string
        }
        Update: {
          alternative_drugs?: Json
          category?: string
          created_at?: string
          created_by?: string | null
          id?: string
          is_deleted?: boolean | null
          name?: string
          reactions?: Json
          severity?: string
          tenant_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "allergens_catalog_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      apk_waitlist: {
        Row: {
          created_at: string | null
          email: string
          id: string
          notified: boolean | null
        }
        Insert: {
          created_at?: string | null
          email: string
          id?: string
          notified?: boolean | null
        }
        Update: {
          created_at?: string | null
          email?: string
          id?: string
          notified?: boolean | null
        }
        Relationships: []
      }
      app_vitals: {
        Row: {
          blood_pressure_diastolic: number | null
          blood_pressure_systolic: number | null
          created_at: string | null
          heart_rate: number | null
          id: string
          patient_id: string | null
          recorded_at: string | null
          source: string | null
          spo2: number | null
          steps_today: number | null
          temperature: number | null
          tenant_id: string | null
          weight: number | null
        }
        Insert: {
          blood_pressure_diastolic?: number | null
          blood_pressure_systolic?: number | null
          created_at?: string | null
          heart_rate?: number | null
          id?: string
          patient_id?: string | null
          recorded_at?: string | null
          source?: string | null
          spo2?: number | null
          steps_today?: number | null
          temperature?: number | null
          tenant_id?: string | null
          weight?: number | null
        }
        Update: {
          blood_pressure_diastolic?: number | null
          blood_pressure_systolic?: number | null
          created_at?: string | null
          heart_rate?: number | null
          id?: string
          patient_id?: string | null
          recorded_at?: string | null
          source?: string | null
          spo2?: number | null
          steps_today?: number | null
          temperature?: number | null
          tenant_id?: string | null
          weight?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "app_vitals_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "app_vitals_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_events: {
        Row: {
          action: string
          created_at: string | null
          id: string
          ip_address: string | null
          new_value: Json | null
          occurred_at: string | null
          previous_value: Json | null
          resource_id: string | null
          resource_type: string
          tenant_id: string
          user_agent: string | null
          user_id: string | null
        }
        Insert: {
          action: string
          created_at?: string | null
          id?: string
          ip_address?: string | null
          new_value?: Json | null
          occurred_at?: string | null
          previous_value?: Json | null
          resource_id?: string | null
          resource_type: string
          tenant_id: string
          user_agent?: string | null
          user_id?: string | null
        }
        Update: {
          action?: string
          created_at?: string | null
          id?: string
          ip_address?: string | null
          new_value?: Json | null
          occurred_at?: string | null
          previous_value?: Json | null
          resource_id?: string | null
          resource_type?: string
          tenant_id?: string
          user_agent?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_log: {
        Row: {
          action: string | null
          created_at: string
          created_by: string | null
          id: string
          is_deleted: boolean | null
          new_value: Json | null
          old_value: Json | null
          record_id: string | null
          table_name: string | null
          tenant_id: string | null
          updated_at: string | null
          user_id: string | null
          user_role: string | null
        }
        Insert: {
          action?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          is_deleted?: boolean | null
          new_value?: Json | null
          old_value?: Json | null
          record_id?: string | null
          table_name?: string | null
          tenant_id?: string | null
          updated_at?: string | null
          user_id?: string | null
          user_role?: string | null
        }
        Update: {
          action?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          is_deleted?: boolean | null
          new_value?: Json | null
          old_value?: Json | null
          record_id?: string | null
          table_name?: string | null
          tenant_id?: string | null
          updated_at?: string | null
          user_id?: string | null
          user_role?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_log_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      auth_otps: {
        Row: {
          attempts: number
          channel: string
          created_at: string
          expires_at: string
          id: string
          otp_hash: string
          target: string
          used: boolean
        }
        Insert: {
          attempts?: number
          channel: string
          created_at?: string
          expires_at?: string
          id?: string
          otp_hash: string
          target: string
          used?: boolean
        }
        Update: {
          attempts?: number
          channel?: string
          created_at?: string
          expires_at?: string
          id?: string
          otp_hash?: string
          target?: string
          used?: boolean
        }
        Relationships: []
      }
      bed_assignments: {
        Row: {
          admission_reason: string | null
          admitted_at: string
          assigned_by: string | null
          bed_id: string
          created_at: string | null
          created_by: string | null
          discharged_at: string | null
          discharged_by: string | null
          encounter_id: string | null
          id: string
          is_deleted: boolean | null
          patient_id: string | null
          tenant_id: string | null
          updated_at: string | null
        }
        Insert: {
          admission_reason?: string | null
          admitted_at?: string
          assigned_by?: string | null
          bed_id: string
          created_at?: string | null
          created_by?: string | null
          discharged_at?: string | null
          discharged_by?: string | null
          encounter_id?: string | null
          id?: string
          is_deleted?: boolean | null
          patient_id?: string | null
          tenant_id?: string | null
          updated_at?: string | null
        }
        Update: {
          admission_reason?: string | null
          admitted_at?: string
          assigned_by?: string | null
          bed_id?: string
          created_at?: string | null
          created_by?: string | null
          discharged_at?: string | null
          discharged_by?: string | null
          encounter_id?: string | null
          id?: string
          is_deleted?: boolean | null
          patient_id?: string | null
          tenant_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "bed_assignments_assigned_by_fkey"
            columns: ["assigned_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bed_assignments_bed_id_fkey"
            columns: ["bed_id"]
            isOneToOne: false
            referencedRelation: "hospital_beds"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bed_assignments_discharged_by_fkey"
            columns: ["discharged_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bed_assignments_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bed_assignments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      beta_access_requests: {
        Row: {
          admin_reply: string | null
          created_at: string
          created_by: string | null
          district: string | null
          email: string
          full_name: string | null
          id: string
          is_deleted: boolean | null
          notes: string | null
          organization: string | null
          phone: string | null
          region: string | null
          replied_at: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          role: string | null
          source: string | null
          status: string
          tenant_id: string | null
          updated_at: string | null
        }
        Insert: {
          admin_reply?: string | null
          created_at?: string
          created_by?: string | null
          district?: string | null
          email: string
          full_name?: string | null
          id?: string
          is_deleted?: boolean | null
          notes?: string | null
          organization?: string | null
          phone?: string | null
          region?: string | null
          replied_at?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          role?: string | null
          source?: string | null
          status?: string
          tenant_id?: string | null
          updated_at?: string | null
        }
        Update: {
          admin_reply?: string | null
          created_at?: string
          created_by?: string | null
          district?: string | null
          email?: string
          full_name?: string | null
          id?: string
          is_deleted?: boolean | null
          notes?: string | null
          organization?: string | null
          phone?: string | null
          region?: string | null
          replied_at?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          role?: string | null
          source?: string | null
          status?: string
          tenant_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "beta_access_requests_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_invoices: {
        Row: {
          created_at: string
          created_by: string | null
          currency: string
          encounter_id: string | null
          id: string
          invoice_number: string | null
          is_deleted: boolean | null
          notes: string | null
          paid_amount: number
          patient_id: string | null
          status: string
          tenant_id: string | null
          total_amount: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          currency?: string
          encounter_id?: string | null
          id?: string
          invoice_number?: string | null
          is_deleted?: boolean | null
          notes?: string | null
          paid_amount?: number
          patient_id?: string | null
          status?: string
          tenant_id?: string | null
          total_amount?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          currency?: string
          encounter_id?: string | null
          id?: string
          invoice_number?: string | null
          is_deleted?: boolean | null
          notes?: string | null
          paid_amount?: number
          patient_id?: string | null
          status?: string
          tenant_id?: string | null
          total_amount?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "billing_invoices_encounter_id_fkey"
            columns: ["encounter_id"]
            isOneToOne: false
            referencedRelation: "encounters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_invoices_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_invoices_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_line_items: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          invoice_id: string
          is_deleted: boolean | null
          item_name: string
          notes: string | null
          qty: number
          tenant_id: string | null
          total_price: number | null
          unit_price: number
          updated_at: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          invoice_id: string
          is_deleted?: boolean | null
          item_name: string
          notes?: string | null
          qty?: number
          tenant_id?: string | null
          total_price?: number | null
          unit_price?: number
          updated_at?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          invoice_id?: string
          is_deleted?: boolean | null
          item_name?: string
          notes?: string | null
          qty?: number
          tenant_id?: string | null
          total_price?: number | null
          unit_price?: number
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "billing_line_items_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "billing_invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_line_items_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      body_register: {
        Row: {
          admission_date: string | null
          body_name: string | null
          body_ref: string | null
          cause_of_death: string | null
          condition_on_arrival: string | null
          created_at: string | null
          created_by: string | null
          id: string
          id_document_verified: boolean | null
          is_forensic: boolean | null
          notes: string | null
          police_notified: boolean | null
          post_mortem_done: boolean | null
          post_mortem_notes: string | null
          referred_from: string | null
          released: boolean | null
          released_date: string | null
          released_relationship: string | null
          released_to: string | null
          storage_bay: string | null
          tenant_id: string
        }
        Insert: {
          admission_date?: string | null
          body_name?: string | null
          body_ref?: string | null
          cause_of_death?: string | null
          condition_on_arrival?: string | null
          created_at?: string | null
          created_by?: string | null
          id?: string
          id_document_verified?: boolean | null
          is_forensic?: boolean | null
          notes?: string | null
          police_notified?: boolean | null
          post_mortem_done?: boolean | null
          post_mortem_notes?: string | null
          referred_from?: string | null
          released?: boolean | null
          released_date?: string | null
          released_relationship?: string | null
          released_to?: string | null
          storage_bay?: string | null
          tenant_id: string
        }
        Update: {
          admission_date?: string | null
          body_name?: string | null
          body_ref?: string | null
          cause_of_death?: string | null
          condition_on_arrival?: string | null
          created_at?: string | null
          created_by?: string | null
          id?: string
          id_document_verified?: boolean | null
          is_forensic?: boolean | null
          notes?: string | null
          police_notified?: boolean | null
          post_mortem_done?: boolean | null
          post_mortem_notes?: string | null
          referred_from?: string | null
          released?: boolean | null
          released_date?: string | null
          released_relationship?: string | null
          released_to?: string | null
          storage_bay?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "body_register_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      calls: {
        Row: {
          call_type: string | null
          callee_id: string | null
          callee_synapse_id: string | null
          caller_id: string | null
          caller_synapse_id: string | null
          created_at: string | null
          duration_seconds: number | null
          ended_at: string | null
          id: string
          room_name: string
          started_at: string | null
          status: string | null
        }
        Insert: {
          call_type?: string | null
          callee_id?: string | null
          callee_synapse_id?: string | null
          caller_id?: string | null
          caller_synapse_id?: string | null
          created_at?: string | null
          duration_seconds?: number | null
          ended_at?: string | null
          id?: string
          room_name: string
          started_at?: string | null
          status?: string | null
        }
        Update: {
          call_type?: string | null
          callee_id?: string | null
          callee_synapse_id?: string | null
          caller_id?: string | null
          caller_synapse_id?: string | null
          created_at?: string | null
          duration_seconds?: number | null
          ended_at?: string | null
          id?: string
          room_name?: string
          started_at?: string | null
          status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "calls_callee_id_fkey"
            columns: ["callee_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "calls_caller_id_fkey"
            columns: ["caller_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      care_team_handovers: {
        Row: {
          acknowledged_at: string | null
          created_at: string
          created_by: string | null
          critical_count: number
          department_id: string | null
          handed_off_by: string | null
          hospital_id: string
          id: string
          incoming_team: string[]
          is_deleted: boolean | null
          metadata: Json
          outgoing_team: string[]
          patient_count: number
          pending_task_count: number
          received_by: string | null
          shift_end: string | null
          shift_start: string
          shift_type: string
          status: string
          submitted_at: string | null
          summary_text: string | null
          tenant_id: string | null
          updated_at: string
        }
        Insert: {
          acknowledged_at?: string | null
          created_at?: string
          created_by?: string | null
          critical_count?: number
          department_id?: string | null
          handed_off_by?: string | null
          hospital_id: string
          id?: string
          incoming_team?: string[]
          is_deleted?: boolean | null
          metadata?: Json
          outgoing_team?: string[]
          patient_count?: number
          pending_task_count?: number
          received_by?: string | null
          shift_end?: string | null
          shift_start: string
          shift_type: string
          status?: string
          submitted_at?: string | null
          summary_text?: string | null
          tenant_id?: string | null
          updated_at?: string
        }
        Update: {
          acknowledged_at?: string | null
          created_at?: string
          created_by?: string | null
          critical_count?: number
          department_id?: string | null
          handed_off_by?: string | null
          hospital_id?: string
          id?: string
          incoming_team?: string[]
          is_deleted?: boolean | null
          metadata?: Json
          outgoing_team?: string[]
          patient_count?: number
          pending_task_count?: number
          received_by?: string | null
          shift_end?: string | null
          shift_start?: string
          shift_type?: string
          status?: string
          submitted_at?: string | null
          summary_text?: string | null
          tenant_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "care_team_handovers_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "care_team_handovers_handed_off_by_fkey"
            columns: ["handed_off_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "care_team_handovers_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "care_team_handovers_received_by_fkey"
            columns: ["received_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "care_team_handovers_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      cds_alerts: {
        Row: {
          category: string | null
          created_at: string
          created_by: string | null
          encounter_id: string | null
          id: string
          is_deleted: boolean | null
          message: string | null
          patient_id: string | null
          payload: Json
          recommendation: string | null
          severity: string | null
          status: string
          tenant_id: string | null
          title: string | null
          trigger_source: string | null
          trigger_type: string | null
          updated_at: string | null
        }
        Insert: {
          category?: string | null
          created_at?: string
          created_by?: string | null
          encounter_id?: string | null
          id?: string
          is_deleted?: boolean | null
          message?: string | null
          patient_id?: string | null
          payload?: Json
          recommendation?: string | null
          severity?: string | null
          status?: string
          tenant_id?: string | null
          title?: string | null
          trigger_source?: string | null
          trigger_type?: string | null
          updated_at?: string | null
        }
        Update: {
          category?: string | null
          created_at?: string
          created_by?: string | null
          encounter_id?: string | null
          id?: string
          is_deleted?: boolean | null
          message?: string | null
          patient_id?: string | null
          payload?: Json
          recommendation?: string | null
          severity?: string | null
          status?: string
          tenant_id?: string | null
          title?: string | null
          trigger_source?: string | null
          trigger_type?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cds_alerts_encounter_id_fkey"
            columns: ["encounter_id"]
            isOneToOne: false
            referencedRelation: "encounters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cds_alerts_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cds_alerts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      cds_rules: {
        Row: {
          created_at: string
          created_by: string | null
          differential_diagnoses: Json | null
          essential_features: Json | null
          icd_code: string
          id: string
          is_deleted: boolean | null
          safety_alerts: Json | null
          suggested_drugs: Json | null
          suggested_labs: Json | null
          tenant_id: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          differential_diagnoses?: Json | null
          essential_features?: Json | null
          icd_code: string
          id?: string
          is_deleted?: boolean | null
          safety_alerts?: Json | null
          suggested_drugs?: Json | null
          suggested_labs?: Json | null
          tenant_id?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          differential_diagnoses?: Json | null
          essential_features?: Json | null
          icd_code?: string
          id?: string
          is_deleted?: boolean | null
          safety_alerts?: Json | null
          suggested_drugs?: Json | null
          suggested_labs?: Json | null
          tenant_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "cds_rules_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      chw_visits: {
        Row: {
          actions_taken: string | null
          campaign_id: string | null
          chw_id: string
          created_at: string
          created_by: string | null
          findings: string | null
          follow_up_date: string | null
          gps_lat: number | null
          gps_lng: number | null
          hospital_id: string | null
          id: string
          is_deleted: boolean | null
          metadata: Json
          muac_cm: number | null
          outcome: string
          patient_id: string | null
          photos: string[]
          referral_needed: boolean
          referral_reason: string | null
          referred_to: string | null
          tenant_id: string | null
          updated_at: string
          village: string | null
          visit_date: string
          visit_type: string
          vitals: Json
        }
        Insert: {
          actions_taken?: string | null
          campaign_id?: string | null
          chw_id: string
          created_at?: string
          created_by?: string | null
          findings?: string | null
          follow_up_date?: string | null
          gps_lat?: number | null
          gps_lng?: number | null
          hospital_id?: string | null
          id?: string
          is_deleted?: boolean | null
          metadata?: Json
          muac_cm?: number | null
          outcome?: string
          patient_id?: string | null
          photos?: string[]
          referral_needed?: boolean
          referral_reason?: string | null
          referred_to?: string | null
          tenant_id?: string | null
          updated_at?: string
          village?: string | null
          visit_date: string
          visit_type: string
          vitals?: Json
        }
        Update: {
          actions_taken?: string | null
          campaign_id?: string | null
          chw_id?: string
          created_at?: string
          created_by?: string | null
          findings?: string | null
          follow_up_date?: string | null
          gps_lat?: number | null
          gps_lng?: number | null
          hospital_id?: string | null
          id?: string
          is_deleted?: boolean | null
          metadata?: Json
          muac_cm?: number | null
          outcome?: string
          patient_id?: string | null
          photos?: string[]
          referral_needed?: boolean
          referral_reason?: string | null
          referred_to?: string | null
          tenant_id?: string | null
          updated_at?: string
          village?: string | null
          visit_date?: string
          visit_type?: string
          vitals?: Json
        }
        Relationships: [
          {
            foreignKeyName: "chw_visits_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "outreach_campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chw_visits_chw_id_fkey"
            columns: ["chw_id"]
            isOneToOne: false
            referencedRelation: "community_health_workers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chw_visits_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chw_visits_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chw_visits_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_line_items: {
        Row: {
          allowed_amount: number | null
          claim_id: string
          created_at: string
          created_by: string | null
          denial_reason: string | null
          id: string
          is_deleted: boolean | null
          modifier_codes: string[]
          ndc_code: string | null
          paid_amount: number | null
          procedure_code: string
          procedure_name: string | null
          quantity: number
          revenue_code: string | null
          service_date: string
          status: string
          tenant_id: string | null
          total_price: number
          unit_price: number
          updated_at: string | null
        }
        Insert: {
          allowed_amount?: number | null
          claim_id: string
          created_at?: string
          created_by?: string | null
          denial_reason?: string | null
          id?: string
          is_deleted?: boolean | null
          modifier_codes?: string[]
          ndc_code?: string | null
          paid_amount?: number | null
          procedure_code: string
          procedure_name?: string | null
          quantity?: number
          revenue_code?: string | null
          service_date: string
          status?: string
          tenant_id?: string | null
          total_price: number
          unit_price: number
          updated_at?: string | null
        }
        Update: {
          allowed_amount?: number | null
          claim_id?: string
          created_at?: string
          created_by?: string | null
          denial_reason?: string | null
          id?: string
          is_deleted?: boolean | null
          modifier_codes?: string[]
          ndc_code?: string | null
          paid_amount?: number | null
          procedure_code?: string
          procedure_name?: string | null
          quantity?: number
          revenue_code?: string | null
          service_date?: string
          status?: string
          tenant_id?: string | null
          total_price?: number
          unit_price?: number
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "claim_line_items_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "insurance_claims"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claim_line_items_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_resubmissions: {
        Row: {
          claim_id: string
          created_at: string
          created_by: string | null
          id: string
          is_deleted: boolean | null
          new_claim_id: string | null
          notes: string | null
          outcome: string | null
          outcome_at: string | null
          reason: string
          resubmission_type: string
          resubmitted_at: string
          resubmitted_by: string | null
          supporting_docs: Json
          tenant_id: string | null
          updated_at: string | null
        }
        Insert: {
          claim_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          is_deleted?: boolean | null
          new_claim_id?: string | null
          notes?: string | null
          outcome?: string | null
          outcome_at?: string | null
          reason: string
          resubmission_type?: string
          resubmitted_at?: string
          resubmitted_by?: string | null
          supporting_docs?: Json
          tenant_id?: string | null
          updated_at?: string | null
        }
        Update: {
          claim_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          is_deleted?: boolean | null
          new_claim_id?: string | null
          notes?: string | null
          outcome?: string | null
          outcome_at?: string | null
          reason?: string
          resubmission_type?: string
          resubmitted_at?: string
          resubmitted_by?: string | null
          supporting_docs?: Json
          tenant_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "claim_resubmissions_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "insurance_claims"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claim_resubmissions_new_claim_id_fkey"
            columns: ["new_claim_id"]
            isOneToOne: false
            referencedRelation: "insurance_claims"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claim_resubmissions_resubmitted_by_fkey"
            columns: ["resubmitted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claim_resubmissions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      clinical_pathway_templates: {
        Row: {
          alert_rules: Json
          auto_orders: Json
          category: string
          checklist: Json
          created_at: string
          created_by: string | null
          description: string | null
          hospital_id: string | null
          icd11_codes: string[]
          id: string
          is_active: boolean
          is_deleted: boolean | null
          is_system: boolean
          name: string
          slug: string
          steps: Json
          tenant_id: string | null
          triggers: Json
          updated_at: string
          version: number
        }
        Insert: {
          alert_rules?: Json
          auto_orders?: Json
          category: string
          checklist?: Json
          created_at?: string
          created_by?: string | null
          description?: string | null
          hospital_id?: string | null
          icd11_codes?: string[]
          id?: string
          is_active?: boolean
          is_deleted?: boolean | null
          is_system?: boolean
          name: string
          slug: string
          steps?: Json
          tenant_id?: string | null
          triggers?: Json
          updated_at?: string
          version?: number
        }
        Update: {
          alert_rules?: Json
          auto_orders?: Json
          category?: string
          checklist?: Json
          created_at?: string
          created_by?: string | null
          description?: string | null
          hospital_id?: string | null
          icd11_codes?: string[]
          id?: string
          is_active?: boolean
          is_deleted?: boolean | null
          is_system?: boolean
          name?: string
          slug?: string
          steps?: Json
          tenant_id?: string | null
          triggers?: Json
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "clinical_pathway_templates_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "clinical_pathway_templates_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "clinical_pathway_templates_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      community_health_workers: {
        Row: {
          chw_code: string
          coverage_area: string | null
          created_at: string
          created_by: string | null
          district: string | null
          full_name: string
          hospital_id: string
          id: string
          is_active: boolean
          is_deleted: boolean | null
          joined_at: string | null
          languages: string[]
          metadata: Json
          phone: string
          profile_id: string | null
          region: string | null
          sub_county: string | null
          tenant_id: string | null
          training_level: string
          updated_at: string
          village: string | null
        }
        Insert: {
          chw_code: string
          coverage_area?: string | null
          created_at?: string
          created_by?: string | null
          district?: string | null
          full_name: string
          hospital_id: string
          id?: string
          is_active?: boolean
          is_deleted?: boolean | null
          joined_at?: string | null
          languages?: string[]
          metadata?: Json
          phone: string
          profile_id?: string | null
          region?: string | null
          sub_county?: string | null
          tenant_id?: string | null
          training_level?: string
          updated_at?: string
          village?: string | null
        }
        Update: {
          chw_code?: string
          coverage_area?: string | null
          created_at?: string
          created_by?: string | null
          district?: string | null
          full_name?: string
          hospital_id?: string
          id?: string
          is_active?: boolean
          is_deleted?: boolean | null
          joined_at?: string | null
          languages?: string[]
          metadata?: Json
          phone?: string
          profile_id?: string | null
          region?: string | null
          sub_county?: string | null
          tenant_id?: string | null
          training_level?: string
          updated_at?: string
          village?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "community_health_workers_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "community_health_workers_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "community_health_workers_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      consent_audit_log: {
        Row: {
          action: string
          actor_id: string | null
          actor_role: string | null
          consent_id: string | null
          created_at: string
          created_by: string | null
          detail: Json
          grant_id: string | null
          id: string
          ip_address: unknown
          is_deleted: boolean | null
          module_name: string | null
          patient_id: string
          tenant_id: string | null
          updated_at: string | null
        }
        Insert: {
          action: string
          actor_id?: string | null
          actor_role?: string | null
          consent_id?: string | null
          created_at?: string
          created_by?: string | null
          detail?: Json
          grant_id?: string | null
          id?: string
          ip_address?: unknown
          is_deleted?: boolean | null
          module_name?: string | null
          patient_id: string
          tenant_id?: string | null
          updated_at?: string | null
        }
        Update: {
          action?: string
          actor_id?: string | null
          actor_role?: string | null
          consent_id?: string | null
          created_at?: string
          created_by?: string | null
          detail?: Json
          grant_id?: string | null
          id?: string
          ip_address?: unknown
          is_deleted?: boolean | null
          module_name?: string | null
          patient_id?: string
          tenant_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "consent_audit_log_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "consent_audit_log_consent_id_fkey"
            columns: ["consent_id"]
            isOneToOne: false
            referencedRelation: "patient_consents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "consent_audit_log_grant_id_fkey"
            columns: ["grant_id"]
            isOneToOne: false
            referencedRelation: "patient_access_grants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "consent_audit_log_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "consent_audit_log_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      consult_queue: {
        Row: {
          assigned_doctor_id: string | null
          case_id: string | null
          chief_complaint: string | null
          claimed_at: string | null
          completed_at: string | null
          created_at: string
          estimated_wait_minutes: number | null
          guest_key: string | null
          id: string
          position: number | null
          specialty_requested: string | null
          status: string
          token: string
          updated_at: string
          urgency: string
        }
        Insert: {
          assigned_doctor_id?: string | null
          case_id?: string | null
          chief_complaint?: string | null
          claimed_at?: string | null
          completed_at?: string | null
          created_at?: string
          estimated_wait_minutes?: number | null
          guest_key?: string | null
          id?: string
          position?: number | null
          specialty_requested?: string | null
          status?: string
          token?: string
          updated_at?: string
          urgency?: string
        }
        Update: {
          assigned_doctor_id?: string | null
          case_id?: string | null
          chief_complaint?: string | null
          claimed_at?: string | null
          completed_at?: string | null
          created_at?: string
          estimated_wait_minutes?: number | null
          guest_key?: string | null
          id?: string
          position?: number | null
          specialty_requested?: string | null
          status?: string
          token?: string
          updated_at?: string
          urgency?: string
        }
        Relationships: [
          {
            foreignKeyName: "consult_queue_assigned_doctor_id_fkey"
            columns: ["assigned_doctor_id"]
            isOneToOne: false
            referencedRelation: "telemedicine_providers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "consult_queue_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "telemedicine_intake_cases"
            referencedColumns: ["id"]
          },
        ]
      }
      data_breach_incidents: {
        Row: {
          affected_records: number
          containment_actions: string | null
          created_at: string
          created_by: string | null
          data_types: string[]
          description: string
          discovered_at: string
          dpo_review: string | null
          hospital_id: string | null
          id: string
          incident_date: string
          is_deleted: boolean | null
          notification_required: boolean
          notified_at: string | null
          notified_regulator: boolean
          reported_by: string | null
          resolved_at: string | null
          resolved_by: string | null
          root_cause: string | null
          severity: string
          status: string
          tenant_id: string | null
          title: string
          updated_at: string
        }
        Insert: {
          affected_records?: number
          containment_actions?: string | null
          created_at?: string
          created_by?: string | null
          data_types?: string[]
          description: string
          discovered_at?: string
          dpo_review?: string | null
          hospital_id?: string | null
          id?: string
          incident_date: string
          is_deleted?: boolean | null
          notification_required?: boolean
          notified_at?: string | null
          notified_regulator?: boolean
          reported_by?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          root_cause?: string | null
          severity: string
          status?: string
          tenant_id?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          affected_records?: number
          containment_actions?: string | null
          created_at?: string
          created_by?: string | null
          data_types?: string[]
          description?: string
          discovered_at?: string
          dpo_review?: string | null
          hospital_id?: string | null
          id?: string
          incident_date?: string
          is_deleted?: boolean | null
          notification_required?: boolean
          notified_at?: string | null
          notified_regulator?: boolean
          reported_by?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          root_cause?: string | null
          severity?: string
          status?: string
          tenant_id?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "data_breach_incidents_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "data_breach_incidents_reported_by_fkey"
            columns: ["reported_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "data_breach_incidents_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "data_breach_incidents_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      data_export_jobs: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          completed_at: string | null
          created_at: string
          created_by: string | null
          deidentify_config: Json
          download_expires_at: string | null
          download_url: string | null
          error_message: string | null
          expires_at: string | null
          export_type: string
          file_size_bytes: number | null
          filters: Json
          format: string
          hospital_id: string | null
          id: string
          is_deidentified: boolean
          is_deleted: boolean | null
          metadata: Json
          requested_by: string
          row_count: number | null
          scope: string
          started_at: string | null
          status: string
          storage_path: string | null
          tenant_id: string | null
          updated_at: string
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          deidentify_config?: Json
          download_expires_at?: string | null
          download_url?: string | null
          error_message?: string | null
          expires_at?: string | null
          export_type: string
          file_size_bytes?: number | null
          filters?: Json
          format?: string
          hospital_id?: string | null
          id?: string
          is_deidentified?: boolean
          is_deleted?: boolean | null
          metadata?: Json
          requested_by: string
          row_count?: number | null
          scope?: string
          started_at?: string | null
          status?: string
          storage_path?: string | null
          tenant_id?: string | null
          updated_at?: string
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          deidentify_config?: Json
          download_expires_at?: string | null
          download_url?: string | null
          error_message?: string | null
          expires_at?: string | null
          export_type?: string
          file_size_bytes?: number | null
          filters?: Json
          format?: string
          hospital_id?: string | null
          id?: string
          is_deidentified?: boolean
          is_deleted?: boolean | null
          metadata?: Json
          requested_by?: string
          row_count?: number | null
          scope?: string
          started_at?: string | null
          status?: string
          storage_path?: string | null
          tenant_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "data_export_jobs_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "data_export_jobs_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "data_export_jobs_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "data_export_jobs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      data_retention_policies: {
        Row: {
          action_on_expiry: string
          created_at: string
          created_by: string | null
          hospital_id: string | null
          id: string
          is_active: boolean
          is_deleted: boolean | null
          last_run_at: string | null
          legal_basis: string
          module_name: string
          notes: string | null
          retention_days: number
          table_name: string
          tenant_id: string | null
          updated_at: string
        }
        Insert: {
          action_on_expiry?: string
          created_at?: string
          created_by?: string | null
          hospital_id?: string | null
          id?: string
          is_active?: boolean
          is_deleted?: boolean | null
          last_run_at?: string | null
          legal_basis?: string
          module_name: string
          notes?: string | null
          retention_days: number
          table_name: string
          tenant_id?: string | null
          updated_at?: string
        }
        Update: {
          action_on_expiry?: string
          created_at?: string
          created_by?: string | null
          hospital_id?: string | null
          id?: string
          is_active?: boolean
          is_deleted?: boolean | null
          last_run_at?: string | null
          legal_basis?: string
          module_name?: string
          notes?: string | null
          retention_days?: number
          table_name?: string
          tenant_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "data_retention_policies_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "data_retention_policies_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      death_registrations: {
        Row: {
          admitted_at: string | null
          age_years: number | null
          antecedent_cause_1: string | null
          antecedent_cause_2: string | null
          certifying_doctor_id: string | null
          contributing_conditions: string | null
          created_at: string | null
          created_by: string | null
          died_at: string
          district_notified: boolean | null
          district_notified_at: string | null
          full_name: string | null
          hospital_id: string
          id: string
          immediate_cause: string
          is_deleted: boolean | null
          is_infectious: boolean
          is_notifiable: boolean
          is_unexplained: boolean
          mrn: string | null
          notes: string | null
          patient_id: string | null
          registered_at: string | null
          registered_by: string | null
          sex: string | null
          tenant_id: string | null
          underlying_cause: string | null
          underlying_cause_icd11: string | null
          updated_at: string | null
          ward: string | null
        }
        Insert: {
          admitted_at?: string | null
          age_years?: number | null
          antecedent_cause_1?: string | null
          antecedent_cause_2?: string | null
          certifying_doctor_id?: string | null
          contributing_conditions?: string | null
          created_at?: string | null
          created_by?: string | null
          died_at: string
          district_notified?: boolean | null
          district_notified_at?: string | null
          full_name?: string | null
          hospital_id: string
          id?: string
          immediate_cause: string
          is_deleted?: boolean | null
          is_infectious?: boolean
          is_notifiable?: boolean
          is_unexplained?: boolean
          mrn?: string | null
          notes?: string | null
          patient_id?: string | null
          registered_at?: string | null
          registered_by?: string | null
          sex?: string | null
          tenant_id?: string | null
          underlying_cause?: string | null
          underlying_cause_icd11?: string | null
          updated_at?: string | null
          ward?: string | null
        }
        Update: {
          admitted_at?: string | null
          age_years?: number | null
          antecedent_cause_1?: string | null
          antecedent_cause_2?: string | null
          certifying_doctor_id?: string | null
          contributing_conditions?: string | null
          created_at?: string | null
          created_by?: string | null
          died_at?: string
          district_notified?: boolean | null
          district_notified_at?: string | null
          full_name?: string | null
          hospital_id?: string
          id?: string
          immediate_cause?: string
          is_deleted?: boolean | null
          is_infectious?: boolean
          is_notifiable?: boolean
          is_unexplained?: boolean
          mrn?: string | null
          notes?: string | null
          patient_id?: string | null
          registered_at?: string | null
          registered_by?: string | null
          sex?: string | null
          tenant_id?: string | null
          underlying_cause?: string | null
          underlying_cause_icd11?: string | null
          updated_at?: string | null
          ward?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "death_registrations_certifying_doctor_id_fkey"
            columns: ["certifying_doctor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "death_registrations_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "death_registrations_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "death_registrations_registered_by_fkey"
            columns: ["registered_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "death_registrations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      death_reports: {
        Row: {
          created_at: string | null
          created_by: string | null
          encounter_id: string | null
          id: string
          is_deleted: boolean | null
          patient_id: string | null
          reported_at: string
          reported_by: string | null
          sequence: string[]
          tenant_id: string | null
          underlying_cause_code: string
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          created_by?: string | null
          encounter_id?: string | null
          id?: string
          is_deleted?: boolean | null
          patient_id?: string | null
          reported_at?: string
          reported_by?: string | null
          sequence?: string[]
          tenant_id?: string | null
          underlying_cause_code: string
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          created_by?: string | null
          encounter_id?: string | null
          id?: string
          is_deleted?: boolean | null
          patient_id?: string | null
          reported_at?: string
          reported_by?: string | null
          sequence?: string[]
          tenant_id?: string | null
          underlying_cause_code?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "death_reports_encounter_id_fkey"
            columns: ["encounter_id"]
            isOneToOne: false
            referencedRelation: "encounters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "death_reports_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "death_reports_reported_by_fkey"
            columns: ["reported_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "death_reports_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      deidentification_profiles: {
        Row: {
          created_at: string
          created_by: string | null
          description: string | null
          field_rules: Json
          hospital_id: string | null
          id: string
          is_active: boolean
          is_default: boolean
          is_deleted: boolean | null
          is_system: boolean
          name: string
          tenant_id: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          field_rules?: Json
          hospital_id?: string | null
          id?: string
          is_active?: boolean
          is_default?: boolean
          is_deleted?: boolean | null
          is_system?: boolean
          name: string
          tenant_id?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          field_rules?: Json
          hospital_id?: string | null
          id?: string
          is_active?: boolean
          is_default?: boolean
          is_deleted?: boolean | null
          is_system?: boolean
          name?: string
          tenant_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "deidentification_profiles_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deidentification_profiles_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deidentification_profiles_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      demo_departments: {
        Row: {
          code: string
          created_at: string | null
          id: string
          name: string
        }
        Insert: {
          code: string
          created_at?: string | null
          id?: string
          name: string
        }
        Update: {
          code?: string
          created_at?: string | null
          id?: string
          name?: string
        }
        Relationships: []
      }
      demo_encounter_orders: {
        Row: {
          created_at: string | null
          description: string
          encounter_id: string | null
          id: string
          order_type: string
          status: string | null
        }
        Insert: {
          created_at?: string | null
          description: string
          encounter_id?: string | null
          id?: string
          order_type: string
          status?: string | null
        }
        Update: {
          created_at?: string | null
          description?: string
          encounter_id?: string | null
          id?: string
          order_type?: string
          status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "demo_encounter_orders_encounter_id_fkey"
            columns: ["encounter_id"]
            isOneToOne: false
            referencedRelation: "demo_encounters"
            referencedColumns: ["id"]
          },
        ]
      }
      demo_encounters: {
        Row: {
          chief_complaint: string | null
          created_at: string | null
          department_id: string | null
          diagnosis: string | null
          doctor_id: string | null
          id: string
          notes: string | null
          patient_id: string | null
          status: string | null
          updated_at: string | null
        }
        Insert: {
          chief_complaint?: string | null
          created_at?: string | null
          department_id?: string | null
          diagnosis?: string | null
          doctor_id?: string | null
          id?: string
          notes?: string | null
          patient_id?: string | null
          status?: string | null
          updated_at?: string | null
        }
        Update: {
          chief_complaint?: string | null
          created_at?: string | null
          department_id?: string | null
          diagnosis?: string | null
          doctor_id?: string | null
          id?: string
          notes?: string | null
          patient_id?: string | null
          status?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "demo_encounters_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "demo_departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "demo_encounters_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "demo_patients"
            referencedColumns: ["id"]
          },
        ]
      }
      demo_lab_results: {
        Row: {
          created_at: string | null
          encounter_id: string | null
          id: string
          patient_id: string | null
          result_value: string | null
          status: string | null
          test_name: string
          unit: string | null
        }
        Insert: {
          created_at?: string | null
          encounter_id?: string | null
          id?: string
          patient_id?: string | null
          result_value?: string | null
          status?: string | null
          test_name: string
          unit?: string | null
        }
        Update: {
          created_at?: string | null
          encounter_id?: string | null
          id?: string
          patient_id?: string | null
          result_value?: string | null
          status?: string | null
          test_name?: string
          unit?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "demo_lab_results_encounter_id_fkey"
            columns: ["encounter_id"]
            isOneToOne: false
            referencedRelation: "demo_encounters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "demo_lab_results_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "demo_patients"
            referencedColumns: ["id"]
          },
        ]
      }
      demo_patients: {
        Row: {
          arrived_at: string | null
          created_at: string | null
          department_id: string | null
          district: string | null
          dob: string | null
          full_name: string
          id: string
          is_deleted: boolean | null
          mrn: string
          nin: string | null
          phone: string | null
          sex: string | null
          triage_status: string | null
        }
        Insert: {
          arrived_at?: string | null
          created_at?: string | null
          department_id?: string | null
          district?: string | null
          dob?: string | null
          full_name: string
          id?: string
          is_deleted?: boolean | null
          mrn: string
          nin?: string | null
          phone?: string | null
          sex?: string | null
          triage_status?: string | null
        }
        Update: {
          arrived_at?: string | null
          created_at?: string | null
          department_id?: string | null
          district?: string | null
          dob?: string | null
          full_name?: string
          id?: string
          is_deleted?: boolean | null
          mrn?: string
          nin?: string | null
          phone?: string | null
          sex?: string | null
          triage_status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "demo_patients_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "demo_departments"
            referencedColumns: ["id"]
          },
        ]
      }
      demo_vitals: {
        Row: {
          bp_diastolic: number | null
          bp_systolic: number | null
          encounter_id: string | null
          heart_rate: number | null
          id: string
          patient_id: string | null
          recorded_at: string | null
          spo2: number | null
          temperature: number | null
          weight_kg: number | null
        }
        Insert: {
          bp_diastolic?: number | null
          bp_systolic?: number | null
          encounter_id?: string | null
          heart_rate?: number | null
          id?: string
          patient_id?: string | null
          recorded_at?: string | null
          spo2?: number | null
          temperature?: number | null
          weight_kg?: number | null
        }
        Update: {
          bp_diastolic?: number | null
          bp_systolic?: number | null
          encounter_id?: string | null
          heart_rate?: number | null
          id?: string
          patient_id?: string | null
          recorded_at?: string | null
          spo2?: number | null
          temperature?: number | null
          weight_kg?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "demo_vitals_encounter_id_fkey"
            columns: ["encounter_id"]
            isOneToOne: false
            referencedRelation: "demo_encounters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "demo_vitals_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "demo_patients"
            referencedColumns: ["id"]
          },
        ]
      }
      denial_analytics_daily: {
        Row: {
          created_at: string
          created_by: string | null
          denial_rate: number | null
          hospital_id: string
          id: string
          insurer_id: string | null
          is_deleted: boolean | null
          report_date: string
          tenant_id: string | null
          top_denial_codes: Json
          total_billed: number
          total_claims: number
          total_denied: number
          total_paid: number
          updated_at: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          denial_rate?: number | null
          hospital_id: string
          id?: string
          insurer_id?: string | null
          is_deleted?: boolean | null
          report_date: string
          tenant_id?: string | null
          top_denial_codes?: Json
          total_billed?: number
          total_claims?: number
          total_denied?: number
          total_paid?: number
          updated_at?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          denial_rate?: number | null
          hospital_id?: string
          id?: string
          insurer_id?: string | null
          is_deleted?: boolean | null
          report_date?: string
          tenant_id?: string | null
          top_denial_codes?: Json
          total_billed?: number
          total_claims?: number
          total_denied?: number
          total_paid?: number
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "denial_analytics_daily_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "denial_analytics_daily_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      departments: {
        Row: {
          created_at: string
          created_by: string | null
          dept_type: string
          hospital_id: string | null
          id: string
          is_active: boolean
          is_deleted: boolean | null
          name: string
          tenant_id: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          dept_type?: string
          hospital_id?: string | null
          id?: string
          is_active?: boolean
          is_deleted?: boolean | null
          name: string
          tenant_id?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          dept_type?: string
          hospital_id?: string | null
          id?: string
          is_active?: boolean
          is_deleted?: boolean | null
          name?: string
          tenant_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "departments_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "departments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      device_alerts: {
        Row: {
          acknowledged_at: string | null
          acknowledged_by: string | null
          alert_type: string
          created_at: string | null
          created_by: string | null
          device_id: string
          hospital_id: string | null
          id: string
          is_deleted: boolean | null
          message: string
          metadata: Json
          patient_id: string | null
          reading_id: string | null
          resolved_at: string | null
          severity: string
          status: string
          tenant_id: string | null
          triggered_at: string
          updated_at: string | null
        }
        Insert: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          alert_type: string
          created_at?: string | null
          created_by?: string | null
          device_id: string
          hospital_id?: string | null
          id?: string
          is_deleted?: boolean | null
          message: string
          metadata?: Json
          patient_id?: string | null
          reading_id?: string | null
          resolved_at?: string | null
          severity: string
          status?: string
          tenant_id?: string | null
          triggered_at?: string
          updated_at?: string | null
        }
        Update: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          alert_type?: string
          created_at?: string | null
          created_by?: string | null
          device_id?: string
          hospital_id?: string | null
          id?: string
          is_deleted?: boolean | null
          message?: string
          metadata?: Json
          patient_id?: string | null
          reading_id?: string | null
          resolved_at?: string | null
          severity?: string
          status?: string
          tenant_id?: string | null
          triggered_at?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "device_alerts_acknowledged_by_fkey"
            columns: ["acknowledged_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "device_alerts_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "medical_devices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "device_alerts_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "device_alerts_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "device_alerts_reading_id_fkey"
            columns: ["reading_id"]
            isOneToOne: false
            referencedRelation: "device_readings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "device_alerts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      device_readings: {
        Row: {
          alert_sent: boolean
          created_at: string | null
          created_by: string | null
          device_id: string
          encounter_id: string | null
          hospital_id: string | null
          id: string
          is_critical: boolean
          is_deleted: boolean | null
          patient_id: string | null
          raw_payload: Json
          read_at: string
          reading_type: string
          tenant_id: string | null
          unit: string | null
          updated_at: string | null
          value: number | null
          value_text: string | null
        }
        Insert: {
          alert_sent?: boolean
          created_at?: string | null
          created_by?: string | null
          device_id: string
          encounter_id?: string | null
          hospital_id?: string | null
          id?: string
          is_critical?: boolean
          is_deleted?: boolean | null
          patient_id?: string | null
          raw_payload?: Json
          read_at?: string
          reading_type: string
          tenant_id?: string | null
          unit?: string | null
          updated_at?: string | null
          value?: number | null
          value_text?: string | null
        }
        Update: {
          alert_sent?: boolean
          created_at?: string | null
          created_by?: string | null
          device_id?: string
          encounter_id?: string | null
          hospital_id?: string | null
          id?: string
          is_critical?: boolean
          is_deleted?: boolean | null
          patient_id?: string | null
          raw_payload?: Json
          read_at?: string
          reading_type?: string
          tenant_id?: string | null
          unit?: string | null
          updated_at?: string | null
          value?: number | null
          value_text?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "device_readings_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "medical_devices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "device_readings_encounter_id_fkey"
            columns: ["encounter_id"]
            isOneToOne: false
            referencedRelation: "encounters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "device_readings_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "device_readings_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "device_readings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      diagnoses: {
        Row: {
          chapter: string | null
          created_at: string
          created_by: string | null
          definition: string | null
          icd_code: string
          id: string
          is_deleted: boolean | null
          tenant_id: string | null
          title: string
          updated_at: string
        }
        Insert: {
          chapter?: string | null
          created_at?: string
          created_by?: string | null
          definition?: string | null
          icd_code: string
          id?: string
          is_deleted?: boolean | null
          tenant_id?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          chapter?: string | null
          created_at?: string
          created_by?: string | null
          definition?: string | null
          icd_code?: string
          id?: string
          is_deleted?: boolean | null
          tenant_id?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "diagnoses_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      diet_logs: {
        Row: {
          ai_analysis: Json | null
          carbs_g: number | null
          created_at: string | null
          estimated_calories: number | null
          fat_g: number | null
          food_name: string
          id: string
          image_url: string | null
          logged_at: string
          meal_type: string | null
          portion_description: string | null
          protein_g: number | null
          user_id: string
        }
        Insert: {
          ai_analysis?: Json | null
          carbs_g?: number | null
          created_at?: string | null
          estimated_calories?: number | null
          fat_g?: number | null
          food_name: string
          id?: string
          image_url?: string | null
          logged_at?: string
          meal_type?: string | null
          portion_description?: string | null
          protein_g?: number | null
          user_id: string
        }
        Update: {
          ai_analysis?: Json | null
          carbs_g?: number | null
          created_at?: string | null
          estimated_calories?: number | null
          fat_g?: number | null
          food_name?: string
          id?: string
          image_url?: string | null
          logged_at?: string
          meal_type?: string | null
          portion_description?: string | null
          protein_g?: number | null
          user_id?: string
        }
        Relationships: []
      }
      doctor_availability_log: {
        Row: {
          created_at: string
          event: string
          id: string
          provider_id: string
        }
        Insert: {
          created_at?: string
          event: string
          id?: string
          provider_id: string
        }
        Update: {
          created_at?: string
          event?: string
          id?: string
          provider_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "doctor_availability_log_provider_id_fkey"
            columns: ["provider_id"]
            isOneToOne: false
            referencedRelation: "telemedicine_providers"
            referencedColumns: ["id"]
          },
        ]
      }
      drug_contraindications: {
        Row: {
          alternative: string | null
          condition_icd11: string
          condition_name: string
          created_at: string
          created_by: string | null
          drug_code: string
          drug_name: string
          id: string
          is_active: boolean
          is_deleted: boolean | null
          reason: string
          severity: string
          source: string
          tenant_id: string | null
          updated_at: string | null
        }
        Insert: {
          alternative?: string | null
          condition_icd11: string
          condition_name: string
          created_at?: string
          created_by?: string | null
          drug_code: string
          drug_name: string
          id?: string
          is_active?: boolean
          is_deleted?: boolean | null
          reason: string
          severity: string
          source?: string
          tenant_id?: string | null
          updated_at?: string | null
        }
        Update: {
          alternative?: string | null
          condition_icd11?: string
          condition_name?: string
          created_at?: string
          created_by?: string | null
          drug_code?: string
          drug_name?: string
          id?: string
          is_active?: boolean
          is_deleted?: boolean | null
          reason?: string
          severity?: string
          source?: string
          tenant_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "drug_contraindications_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      drug_dose_adjustments: {
        Row: {
          adjusted_dose: string | null
          created_at: string
          created_by: string | null
          dose_note: string | null
          drug_code: string
          drug_name: string
          id: string
          is_active: boolean
          is_avoid: boolean
          is_deleted: boolean | null
          organ_type: string
          reference_range: string
          source: string
          standard_dose: string | null
          tenant_id: string | null
          updated_at: string | null
        }
        Insert: {
          adjusted_dose?: string | null
          created_at?: string
          created_by?: string | null
          dose_note?: string | null
          drug_code: string
          drug_name: string
          id?: string
          is_active?: boolean
          is_avoid?: boolean
          is_deleted?: boolean | null
          organ_type: string
          reference_range: string
          source?: string
          standard_dose?: string | null
          tenant_id?: string | null
          updated_at?: string | null
        }
        Update: {
          adjusted_dose?: string | null
          created_at?: string
          created_by?: string | null
          dose_note?: string | null
          drug_code?: string
          drug_name?: string
          id?: string
          is_active?: boolean
          is_avoid?: boolean
          is_deleted?: boolean | null
          organ_type?: string
          reference_range?: string
          source?: string
          standard_dose?: string | null
          tenant_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "drug_dose_adjustments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      drug_interactions: {
        Row: {
          clinical_effect: string
          created_at: string
          created_by: string | null
          drug_a_code: string
          drug_a_name: string
          drug_b_code: string
          drug_b_name: string
          id: string
          is_active: boolean
          is_deleted: boolean | null
          management: string | null
          mechanism: string | null
          reference_sources: Json
          severity: string
          source: string
          tenant_id: string | null
          updated_at: string | null
        }
        Insert: {
          clinical_effect: string
          created_at?: string
          created_by?: string | null
          drug_a_code: string
          drug_a_name: string
          drug_b_code: string
          drug_b_name: string
          id?: string
          is_active?: boolean
          is_deleted?: boolean | null
          management?: string | null
          mechanism?: string | null
          reference_sources?: Json
          severity: string
          source?: string
          tenant_id?: string | null
          updated_at?: string | null
        }
        Update: {
          clinical_effect?: string
          created_at?: string
          created_by?: string | null
          drug_a_code?: string
          drug_a_name?: string
          drug_b_code?: string
          drug_b_name?: string
          id?: string
          is_active?: boolean
          is_deleted?: boolean | null
          management?: string | null
          mechanism?: string | null
          reference_sources?: Json
          severity?: string
          source?: string
          tenant_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "drug_interactions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      drug_interactions_catalog: {
        Row: {
          alternative: string | null
          created_at: string
          created_by: string | null
          drug1_atc: string
          drug2_atc: string
          id: string
          is_deleted: boolean | null
          mechanism: string
          recommendation: string
          severity: string
          tenant_id: string | null
          updated_at: string
        }
        Insert: {
          alternative?: string | null
          created_at?: string
          created_by?: string | null
          drug1_atc: string
          drug2_atc: string
          id?: string
          is_deleted?: boolean | null
          mechanism: string
          recommendation: string
          severity: string
          tenant_id?: string | null
          updated_at?: string
        }
        Update: {
          alternative?: string | null
          created_at?: string
          created_by?: string | null
          drug1_atc?: string
          drug2_atc?: string
          id?: string
          is_deleted?: boolean | null
          mechanism?: string
          recommendation?: string
          severity?: string
          tenant_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "drug_interactions_catalog_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      drug_shortage_alerts: {
        Row: {
          affected_districts: string[]
          alert_level: string
          created_at: string
          created_by: string | null
          drug_code: string | null
          drug_name: string
          generic_name: string | null
          id: string
          is_active: boolean
          pharmacy_count_affected: number
          resolved_at: string | null
        }
        Insert: {
          affected_districts?: string[]
          alert_level: string
          created_at?: string
          created_by?: string | null
          drug_code?: string | null
          drug_name: string
          generic_name?: string | null
          id?: string
          is_active?: boolean
          pharmacy_count_affected?: number
          resolved_at?: string | null
        }
        Update: {
          affected_districts?: string[]
          alert_level?: string
          created_at?: string
          created_by?: string | null
          drug_code?: string | null
          drug_name?: string
          generic_name?: string | null
          id?: string
          is_active?: boolean
          pharmacy_count_affected?: number
          resolved_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "drug_shortage_alerts_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      encounter_diagnoses: {
        Row: {
          certainty: string | null
          cluster_code: string
          created_at: string
          created_by: string | null
          diagnosis_type: string | null
          encounter_id: string
          foundation_uri: string | null
          id: string
          is_deleted: boolean | null
          stem_code: string
          tenant_id: string | null
          title: string
          updated_at: string | null
        }
        Insert: {
          certainty?: string | null
          cluster_code: string
          created_at?: string
          created_by?: string | null
          diagnosis_type?: string | null
          encounter_id: string
          foundation_uri?: string | null
          id?: string
          is_deleted?: boolean | null
          stem_code: string
          tenant_id?: string | null
          title: string
          updated_at?: string | null
        }
        Update: {
          certainty?: string | null
          cluster_code?: string
          created_at?: string
          created_by?: string | null
          diagnosis_type?: string | null
          encounter_id?: string
          foundation_uri?: string | null
          id?: string
          is_deleted?: boolean | null
          stem_code?: string
          tenant_id?: string | null
          title?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "encounter_diagnoses_encounter_id_fkey"
            columns: ["encounter_id"]
            isOneToOne: false
            referencedRelation: "encounters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "encounter_diagnoses_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      encounter_orders: {
        Row: {
          code: string
          created_at: string
          created_by: string | null
          encounter_diagnosis_id: string | null
          encounter_id: string
          id: string
          is_deleted: boolean | null
          name: string
          order_type: string
          status: string | null
          tenant_id: string | null
          updated_at: string | null
          version: number
        }
        Insert: {
          code: string
          created_at?: string
          created_by?: string | null
          encounter_diagnosis_id?: string | null
          encounter_id: string
          id?: string
          is_deleted?: boolean | null
          name: string
          order_type: string
          status?: string | null
          tenant_id?: string | null
          updated_at?: string | null
          version?: number
        }
        Update: {
          code?: string
          created_at?: string
          created_by?: string | null
          encounter_diagnosis_id?: string | null
          encounter_id?: string
          id?: string
          is_deleted?: boolean | null
          name?: string
          order_type?: string
          status?: string | null
          tenant_id?: string | null
          updated_at?: string | null
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "encounter_orders_encounter_diagnosis_id_fkey"
            columns: ["encounter_diagnosis_id"]
            isOneToOne: false
            referencedRelation: "encounter_diagnoses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "encounter_orders_encounter_id_fkey"
            columns: ["encounter_id"]
            isOneToOne: false
            referencedRelation: "encounters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "encounter_orders_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      encounters: {
        Row: {
          chief_complaint: string | null
          clinical_stage: string | null
          clinician_id: string | null
          created_at: string
          created_by: string | null
          department_id: string | null
          hospital_id: string | null
          id: string
          is_deleted: boolean | null
          metadata: Json | null
          patient_id: string | null
          patient_identifier_hash: string | null
          tenant_id: string | null
          updated_at: string
          version: number
          visit_date: string | null
        }
        Insert: {
          chief_complaint?: string | null
          clinical_stage?: string | null
          clinician_id?: string | null
          created_at?: string
          created_by?: string | null
          department_id?: string | null
          hospital_id?: string | null
          id?: string
          is_deleted?: boolean | null
          metadata?: Json | null
          patient_id?: string | null
          patient_identifier_hash?: string | null
          tenant_id?: string | null
          updated_at?: string
          version?: number
          visit_date?: string | null
        }
        Update: {
          chief_complaint?: string | null
          clinical_stage?: string | null
          clinician_id?: string | null
          created_at?: string
          created_by?: string | null
          department_id?: string | null
          hospital_id?: string | null
          id?: string
          is_deleted?: boolean | null
          metadata?: Json | null
          patient_id?: string | null
          patient_identifier_hash?: string | null
          tenant_id?: string | null
          updated_at?: string
          version?: number
          visit_date?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "encounters_clinician_id_fkey"
            columns: ["clinician_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "encounters_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "encounters_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "encounters_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "encounters_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      expert_rules: {
        Row: {
          active: boolean
          category: string
          country_code: string | null
          created_at: string
          created_by: string | null
          description: string | null
          effective_date: string
          evidence_level: string | null
          expiry_date: string | null
          id: string
          is_deleted: boolean | null
          metadata: Json
          name: string
          outcomes: Json
          priority: number
          rule_content: Json
          rule_format: string
          rule_id: string
          source: string
          source_id: string | null
          specialty: string | null
          tenant_id: string | null
          updated_at: string
          validated_by: string | null
          validation_date: string | null
          variables: Json
          version: string
        }
        Insert: {
          active?: boolean
          category: string
          country_code?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          effective_date?: string
          evidence_level?: string | null
          expiry_date?: string | null
          id?: string
          is_deleted?: boolean | null
          metadata?: Json
          name: string
          outcomes?: Json
          priority?: number
          rule_content: Json
          rule_format?: string
          rule_id: string
          source: string
          source_id?: string | null
          specialty?: string | null
          tenant_id?: string | null
          updated_at?: string
          validated_by?: string | null
          validation_date?: string | null
          variables?: Json
          version?: string
        }
        Update: {
          active?: boolean
          category?: string
          country_code?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          effective_date?: string
          evidence_level?: string | null
          expiry_date?: string | null
          id?: string
          is_deleted?: boolean | null
          metadata?: Json
          name?: string
          outcomes?: Json
          priority?: number
          rule_content?: Json
          rule_format?: string
          rule_id?: string
          source?: string
          source_id?: string | null
          specialty?: string | null
          tenant_id?: string | null
          updated_at?: string
          validated_by?: string | null
          validation_date?: string | null
          variables?: Json
          version?: string
        }
        Relationships: [
          {
            foreignKeyName: "expert_rules_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      facility_resource_logs: {
        Row: {
          details: Json | null
          hospital_id: string | null
          id: string
          recorded_at: string
          recorded_by: string | null
          resource_type: string
          unit: string | null
          value: number
        }
        Insert: {
          details?: Json | null
          hospital_id?: string | null
          id?: string
          recorded_at?: string
          recorded_by?: string | null
          resource_type: string
          unit?: string | null
          value: number
        }
        Update: {
          details?: Json | null
          hospital_id?: string | null
          id?: string
          recorded_at?: string
          recorded_by?: string | null
          resource_type?: string
          unit?: string | null
          value?: number
        }
        Relationships: [
          {
            foreignKeyName: "facility_resource_logs_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "facility_resource_logs_recorded_by_fkey"
            columns: ["recorded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      feature_flags: {
        Row: {
          created_at: string
          enabled_at: string | null
          enabled_by: string | null
          feature_key: string
          id: string
          is_enabled: boolean
          notes: string | null
          tenant_id: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          enabled_at?: string | null
          enabled_by?: string | null
          feature_key: string
          id?: string
          is_enabled?: boolean
          notes?: string | null
          tenant_id?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          enabled_at?: string | null
          enabled_by?: string | null
          feature_key?: string
          id?: string
          is_enabled?: boolean
          notes?: string | null
          tenant_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "feature_flags_enabled_by_fkey"
            columns: ["enabled_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "feature_flags_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      gas_cylinders: {
        Row: {
          created_at: string | null
          created_by: string | null
          customer_id: string | null
          cylinder_size: string
          id: string
          is_deleted: boolean | null
          last_swap: string | null
          status: string | null
          tenant_id: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          created_by?: string | null
          customer_id?: string | null
          cylinder_size: string
          id?: string
          is_deleted?: boolean | null
          last_swap?: string | null
          status?: string | null
          tenant_id?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          created_by?: string | null
          customer_id?: string | null
          cylinder_size?: string
          id?: string
          is_deleted?: boolean | null
          last_swap?: string | null
          status?: string | null
          tenant_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "gas_cylinders_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gas_cylinders_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      habit_logs: {
        Row: {
          created_at: string | null
          habit_id: string
          id: string
          logged_at: string
          note: string | null
          user_id: string
          value: number | null
        }
        Insert: {
          created_at?: string | null
          habit_id: string
          id?: string
          logged_at?: string
          note?: string | null
          user_id: string
          value?: number | null
        }
        Update: {
          created_at?: string | null
          habit_id?: string
          id?: string
          logged_at?: string
          note?: string | null
          user_id?: string
          value?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "habit_logs_habit_id_fkey"
            columns: ["habit_id"]
            isOneToOne: false
            referencedRelation: "health_habits"
            referencedColumns: ["id"]
          },
        ]
      }
      handover_patient_entries: {
        Row: {
          active_orders: Json
          active_pathways: Json
          acuity_level: string
          ai_summary: string | null
          bed_location: string | null
          completed_tasks: Json
          created_at: string
          created_by: string | null
          handover_id: string
          hospital_id: string | null
          id: string
          is_deleted: boolean | null
          patient_id: string
          pending_tasks: Json
          sbar_assessment: string | null
          sbar_background: string | null
          sbar_recommendation: string | null
          sbar_situation: string | null
          tenant_id: string | null
          updated_at: string
        }
        Insert: {
          active_orders?: Json
          active_pathways?: Json
          acuity_level?: string
          ai_summary?: string | null
          bed_location?: string | null
          completed_tasks?: Json
          created_at?: string
          created_by?: string | null
          handover_id: string
          hospital_id?: string | null
          id?: string
          is_deleted?: boolean | null
          patient_id: string
          pending_tasks?: Json
          sbar_assessment?: string | null
          sbar_background?: string | null
          sbar_recommendation?: string | null
          sbar_situation?: string | null
          tenant_id?: string | null
          updated_at?: string
        }
        Update: {
          active_orders?: Json
          active_pathways?: Json
          acuity_level?: string
          ai_summary?: string | null
          bed_location?: string | null
          completed_tasks?: Json
          created_at?: string
          created_by?: string | null
          handover_id?: string
          hospital_id?: string | null
          id?: string
          is_deleted?: boolean | null
          patient_id?: string
          pending_tasks?: Json
          sbar_assessment?: string | null
          sbar_background?: string | null
          sbar_recommendation?: string | null
          sbar_situation?: string | null
          tenant_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "handover_patient_entries_handover_id_fkey"
            columns: ["handover_id"]
            isOneToOne: false
            referencedRelation: "care_team_handovers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "handover_patient_entries_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "handover_patient_entries_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      handover_shift_tasks: {
        Row: {
          assigned_to: string | null
          carried_over_to: string | null
          completed_at: string | null
          created_at: string
          created_by: string | null
          due_at: string | null
          handover_id: string
          id: string
          is_deleted: boolean | null
          notes: string | null
          priority: string
          status: string
          task_type: string
          tenant_id: string | null
          title: string
          updated_at: string
        }
        Insert: {
          assigned_to?: string | null
          carried_over_to?: string | null
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          due_at?: string | null
          handover_id: string
          id?: string
          is_deleted?: boolean | null
          notes?: string | null
          priority?: string
          status?: string
          task_type?: string
          tenant_id?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          assigned_to?: string | null
          carried_over_to?: string | null
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          due_at?: string | null
          handover_id?: string
          id?: string
          is_deleted?: boolean | null
          notes?: string | null
          priority?: string
          status?: string
          task_type?: string
          tenant_id?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "handover_shift_tasks_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "handover_shift_tasks_carried_over_to_fkey"
            columns: ["carried_over_to"]
            isOneToOne: false
            referencedRelation: "care_team_handovers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "handover_shift_tasks_handover_id_fkey"
            columns: ["handover_id"]
            isOneToOne: false
            referencedRelation: "care_team_handovers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "handover_shift_tasks_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      handover_signatures: {
        Row: {
          created_at: string | null
          created_by: string | null
          handover_id: string
          id: string
          ip_address: unknown
          is_deleted: boolean | null
          role: string
          signature: string | null
          signed_at: string
          signer_id: string
          tenant_id: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          created_by?: string | null
          handover_id: string
          id?: string
          ip_address?: unknown
          is_deleted?: boolean | null
          role: string
          signature?: string | null
          signed_at?: string
          signer_id: string
          tenant_id?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          created_by?: string | null
          handover_id?: string
          id?: string
          ip_address?: unknown
          is_deleted?: boolean | null
          role?: string
          signature?: string | null
          signed_at?: string
          signer_id?: string
          tenant_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "handover_signatures_handover_id_fkey"
            columns: ["handover_id"]
            isOneToOne: false
            referencedRelation: "care_team_handovers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "handover_signatures_signer_id_fkey"
            columns: ["signer_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "handover_signatures_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      health_bulletins: {
        Row: {
          body: string
          created_at: string | null
          id: string
          severity: string | null
          target_type: string | null
          target_value: string | null
          tenant_id: string | null
          title: string
        }
        Insert: {
          body: string
          created_at?: string | null
          id?: string
          severity?: string | null
          target_type?: string | null
          target_value?: string | null
          tenant_id?: string | null
          title: string
        }
        Update: {
          body?: string
          created_at?: string | null
          id?: string
          severity?: string | null
          target_type?: string | null
          target_value?: string | null
          tenant_id?: string | null
          title?: string
        }
        Relationships: []
      }
      health_habits: {
        Row: {
          category: string | null
          created_at: string | null
          frequency: string | null
          id: string
          is_active: boolean | null
          last_logged_at: string | null
          name: string
          streak_days: number | null
          target_unit: string | null
          target_value: number | null
          user_id: string
        }
        Insert: {
          category?: string | null
          created_at?: string | null
          frequency?: string | null
          id?: string
          is_active?: boolean | null
          last_logged_at?: string | null
          name: string
          streak_days?: number | null
          target_unit?: string | null
          target_value?: number | null
          user_id: string
        }
        Update: {
          category?: string | null
          created_at?: string | null
          frequency?: string | null
          id?: string
          is_active?: boolean | null
          last_logged_at?: string | null
          name?: string
          streak_days?: number | null
          target_unit?: string | null
          target_value?: number | null
          user_id?: string
        }
        Relationships: []
      }
      hospital_beds: {
        Row: {
          bed_number: string
          bed_type: string
          building: string | null
          created_at: string | null
          created_by: string | null
          current_patient_id: string | null
          floor: number | null
          hospital_id: string
          id: string
          is_deleted: boolean | null
          last_cleaned_at: string | null
          last_status_change: string | null
          notes: string | null
          qr_code: string | null
          room: string | null
          status: string
          tenant_id: string | null
          updated_at: string
          ward: string
        }
        Insert: {
          bed_number: string
          bed_type?: string
          building?: string | null
          created_at?: string | null
          created_by?: string | null
          current_patient_id?: string | null
          floor?: number | null
          hospital_id: string
          id?: string
          is_deleted?: boolean | null
          last_cleaned_at?: string | null
          last_status_change?: string | null
          notes?: string | null
          qr_code?: string | null
          room?: string | null
          status?: string
          tenant_id?: string | null
          updated_at?: string
          ward: string
        }
        Update: {
          bed_number?: string
          bed_type?: string
          building?: string | null
          created_at?: string | null
          created_by?: string | null
          current_patient_id?: string | null
          floor?: number | null
          hospital_id?: string
          id?: string
          is_deleted?: boolean | null
          last_cleaned_at?: string | null
          last_status_change?: string | null
          notes?: string | null
          qr_code?: string | null
          room?: string | null
          status?: string
          tenant_id?: string | null
          updated_at?: string
          ward?: string
        }
        Relationships: [
          {
            foreignKeyName: "hospital_beds_current_patient_id_fkey"
            columns: ["current_patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hospital_beds_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hospital_beds_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      hospital_drug_orders: {
        Row: {
          atc_code: string | null
          created_at: string
          created_by: string | null
          drug_name: string
          encounter_id: string
          epharm_product_id: string | null
          id: string
          is_deleted: boolean | null
          notes: string | null
          patient_identifier_hash: string | null
          qty_ordered: number
          status: string
          tenant_id: string | null
          unit: string
          unit_price: number | null
          updated_at: string
          version: number
        }
        Insert: {
          atc_code?: string | null
          created_at?: string
          created_by?: string | null
          drug_name: string
          encounter_id: string
          epharm_product_id?: string | null
          id?: string
          is_deleted?: boolean | null
          notes?: string | null
          patient_identifier_hash?: string | null
          qty_ordered?: number
          status?: string
          tenant_id?: string | null
          unit?: string
          unit_price?: number | null
          updated_at?: string
          version?: number
        }
        Update: {
          atc_code?: string | null
          created_at?: string
          created_by?: string | null
          drug_name?: string
          encounter_id?: string
          epharm_product_id?: string | null
          id?: string
          is_deleted?: boolean | null
          notes?: string | null
          patient_identifier_hash?: string | null
          qty_ordered?: number
          status?: string
          tenant_id?: string | null
          unit?: string
          unit_price?: number | null
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "hospital_drug_orders_encounter_id_fkey"
            columns: ["encounter_id"]
            isOneToOne: false
            referencedRelation: "encounters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hospital_drug_orders_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      hospital_modules: {
        Row: {
          activated_at: string | null
          created_at: string | null
          hospital_id: string | null
          id: string
          is_active: boolean | null
          module_key: string
          tenant_id: string | null
        }
        Insert: {
          activated_at?: string | null
          created_at?: string | null
          hospital_id?: string | null
          id?: string
          is_active?: boolean | null
          module_key: string
          tenant_id?: string | null
        }
        Update: {
          activated_at?: string | null
          created_at?: string | null
          hospital_id?: string | null
          id?: string
          is_active?: boolean | null
          module_key?: string
          tenant_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "hospital_modules_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
        ]
      }
      hospital_settings: {
        Row: {
          address: string | null
          created_at: string
          created_by: string | null
          currency_code: string
          email: string | null
          hospital_name: string | null
          id: string
          is_deleted: boolean | null
          phone: string | null
          tax_rate_percent: number
          tenant_id: string | null
          updated_at: string
        }
        Insert: {
          address?: string | null
          created_at?: string
          created_by?: string | null
          currency_code?: string
          email?: string | null
          hospital_name?: string | null
          id?: string
          is_deleted?: boolean | null
          phone?: string | null
          tax_rate_percent?: number
          tenant_id?: string | null
          updated_at?: string
        }
        Update: {
          address?: string | null
          created_at?: string
          created_by?: string | null
          currency_code?: string
          email?: string | null
          hospital_name?: string | null
          id?: string
          is_deleted?: boolean | null
          phone?: string | null
          tax_rate_percent?: number
          tenant_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "hospital_settings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      hospitals: {
        Row: {
          created_at: string
          id: string
          name: string
          settings: Json | null
          subdomain: string
          type: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          settings?: Json | null
          subdomain: string
          type?: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          settings?: Json | null
          subdomain?: string
          type?: string
        }
        Relationships: []
      }
      housekeeping_tasks: {
        Row: {
          area: string
          assigned_to: string | null
          completed: boolean | null
          completed_at: string | null
          created_at: string | null
          id: string
          notes: string | null
          scheduled_time: string | null
          task_description: string | null
          task_type: string | null
          tenant_id: string
          verification_notes: string | null
          verified_by: string | null
        }
        Insert: {
          area: string
          assigned_to?: string | null
          completed?: boolean | null
          completed_at?: string | null
          created_at?: string | null
          id?: string
          notes?: string | null
          scheduled_time?: string | null
          task_description?: string | null
          task_type?: string | null
          tenant_id: string
          verification_notes?: string | null
          verified_by?: string | null
        }
        Update: {
          area?: string
          assigned_to?: string | null
          completed?: boolean | null
          completed_at?: string | null
          created_at?: string | null
          id?: string
          notes?: string | null
          scheduled_time?: string | null
          task_description?: string | null
          task_type?: string | null
          tenant_id?: string
          verification_notes?: string | null
          verified_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "housekeeping_tasks_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      imaging_series: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          is_deleted: boolean | null
          modality: string | null
          number_of_images: number
          series_description: string | null
          series_number: number | null
          series_uid: string | null
          storage_path: string | null
          study_id: string
          tenant_id: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          is_deleted?: boolean | null
          modality?: string | null
          number_of_images?: number
          series_description?: string | null
          series_number?: number | null
          series_uid?: string | null
          storage_path?: string | null
          study_id: string
          tenant_id?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          is_deleted?: boolean | null
          modality?: string | null
          number_of_images?: number
          series_description?: string | null
          series_number?: number | null
          series_uid?: string | null
          storage_path?: string | null
          study_id?: string
          tenant_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "imaging_series_study_id_fkey"
            columns: ["study_id"]
            isOneToOne: false
            referencedRelation: "imaging_studies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "imaging_series_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      imaging_studies: {
        Row: {
          accession_number: string | null
          body_part: string | null
          clinical_indication: string | null
          created_at: string
          created_by: string | null
          dicom_json: Json | null
          encounter_id: string | null
          file_size_bytes: number | null
          hospital_id: string | null
          id: string
          is_deleted: boolean | null
          is_urgent: boolean
          laterality: string | null
          metadata: Json
          modality: string
          number_of_instances: number
          number_of_series: number
          order_id: string | null
          patient_id: string
          priority: string
          status: string
          storage_path: string | null
          storage_provider: string
          study_date: string
          study_description: string | null
          study_uid: string | null
          tenant_id: string | null
          thumbnail_path: string | null
          updated_at: string
          worklist_status: string
        }
        Insert: {
          accession_number?: string | null
          body_part?: string | null
          clinical_indication?: string | null
          created_at?: string
          created_by?: string | null
          dicom_json?: Json | null
          encounter_id?: string | null
          file_size_bytes?: number | null
          hospital_id?: string | null
          id?: string
          is_deleted?: boolean | null
          is_urgent?: boolean
          laterality?: string | null
          metadata?: Json
          modality: string
          number_of_instances?: number
          number_of_series?: number
          order_id?: string | null
          patient_id: string
          priority?: string
          status?: string
          storage_path?: string | null
          storage_provider?: string
          study_date?: string
          study_description?: string | null
          study_uid?: string | null
          tenant_id?: string | null
          thumbnail_path?: string | null
          updated_at?: string
          worklist_status?: string
        }
        Update: {
          accession_number?: string | null
          body_part?: string | null
          clinical_indication?: string | null
          created_at?: string
          created_by?: string | null
          dicom_json?: Json | null
          encounter_id?: string | null
          file_size_bytes?: number | null
          hospital_id?: string | null
          id?: string
          is_deleted?: boolean | null
          is_urgent?: boolean
          laterality?: string | null
          metadata?: Json
          modality?: string
          number_of_instances?: number
          number_of_series?: number
          order_id?: string | null
          patient_id?: string
          priority?: string
          status?: string
          storage_path?: string | null
          storage_provider?: string
          study_date?: string
          study_description?: string | null
          study_uid?: string | null
          tenant_id?: string | null
          thumbnail_path?: string | null
          updated_at?: string
          worklist_status?: string
        }
        Relationships: [
          {
            foreignKeyName: "imaging_studies_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "imaging_studies_encounter_id_fkey"
            columns: ["encounter_id"]
            isOneToOne: false
            referencedRelation: "encounters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "imaging_studies_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "imaging_studies_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "imaging_studies_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      immunization_schedule: {
        Row: {
          administered_by: string | null
          created_at: string
          created_by: string | null
          due_date: string
          given_date: string | null
          id: string
          is_deleted: boolean | null
          loinc_code: string | null
          notes: string | null
          patient_id: string
          site: string | null
          status: string
          tenant_id: string | null
          updated_at: string
          vaccine_abbr: string | null
          vaccine_name: string
        }
        Insert: {
          administered_by?: string | null
          created_at?: string
          created_by?: string | null
          due_date: string
          given_date?: string | null
          id?: string
          is_deleted?: boolean | null
          loinc_code?: string | null
          notes?: string | null
          patient_id: string
          site?: string | null
          status?: string
          tenant_id?: string | null
          updated_at?: string
          vaccine_abbr?: string | null
          vaccine_name: string
        }
        Update: {
          administered_by?: string | null
          created_at?: string
          created_by?: string | null
          due_date?: string
          given_date?: string | null
          id?: string
          is_deleted?: boolean | null
          loinc_code?: string | null
          notes?: string | null
          patient_id?: string
          site?: string | null
          status?: string
          tenant_id?: string | null
          updated_at?: string
          vaccine_abbr?: string | null
          vaccine_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "immunization_schedule_administered_by_fkey"
            columns: ["administered_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "immunization_schedule_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "immunization_schedule_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      import_batch_rows: {
        Row: {
          batch_id: string
          created_at: string
          created_by: string | null
          dedupe_key: string | null
          entity: string
          id: string
          imported_record_id: string | null
          is_deleted: boolean | null
          normalized_record: Json | null
          row_number: number
          source_record: Json
          status: string
          tenant_id: string | null
          updated_at: string
          validation_errors: Json
        }
        Insert: {
          batch_id: string
          created_at?: string
          created_by?: string | null
          dedupe_key?: string | null
          entity: string
          id?: string
          imported_record_id?: string | null
          is_deleted?: boolean | null
          normalized_record?: Json | null
          row_number: number
          source_record: Json
          status?: string
          tenant_id?: string | null
          updated_at?: string
          validation_errors?: Json
        }
        Update: {
          batch_id?: string
          created_at?: string
          created_by?: string | null
          dedupe_key?: string | null
          entity?: string
          id?: string
          imported_record_id?: string | null
          is_deleted?: boolean | null
          normalized_record?: Json | null
          row_number?: number
          source_record?: Json
          status?: string
          tenant_id?: string | null
          updated_at?: string
          validation_errors?: Json
        }
        Relationships: [
          {
            foreignKeyName: "import_batch_rows_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "import_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_batch_rows_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      import_batches: {
        Row: {
          created_at: string
          created_by: string | null
          error_rows: number
          finished_at: string | null
          hospital_id: string
          id: string
          import_scope: string
          is_deleted: boolean | null
          options: Json
          source_name: string
          source_type: string
          started_at: string | null
          status: string
          summary: Json
          tenant_id: string | null
          total_rows: number
          updated_at: string
          valid_rows: number
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          error_rows?: number
          finished_at?: string | null
          hospital_id: string
          id?: string
          import_scope?: string
          is_deleted?: boolean | null
          options?: Json
          source_name: string
          source_type: string
          started_at?: string | null
          status?: string
          summary?: Json
          tenant_id?: string | null
          total_rows?: number
          updated_at?: string
          valid_rows?: number
        }
        Update: {
          created_at?: string
          created_by?: string | null
          error_rows?: number
          finished_at?: string | null
          hospital_id?: string
          id?: string
          import_scope?: string
          is_deleted?: boolean | null
          options?: Json
          source_name?: string
          source_type?: string
          started_at?: string | null
          status?: string
          summary?: Json
          tenant_id?: string | null
          total_rows?: number
          updated_at?: string
          valid_rows?: number
        }
        Relationships: [
          {
            foreignKeyName: "import_batches_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_batches_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_batches_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      import_column_mappings: {
        Row: {
          batch_id: string
          created_at: string
          created_by: string | null
          entity: string
          id: string
          is_deleted: boolean | null
          is_required: boolean
          source_column: string
          target_column: string
          tenant_id: string | null
          transform_rule: string | null
          updated_at: string | null
        }
        Insert: {
          batch_id: string
          created_at?: string
          created_by?: string | null
          entity: string
          id?: string
          is_deleted?: boolean | null
          is_required?: boolean
          source_column: string
          target_column: string
          tenant_id?: string | null
          transform_rule?: string | null
          updated_at?: string | null
        }
        Update: {
          batch_id?: string
          created_at?: string
          created_by?: string | null
          entity?: string
          id?: string
          is_deleted?: boolean | null
          is_required?: boolean
          source_column?: string
          target_column?: string
          tenant_id?: string | null
          transform_rule?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "import_column_mappings_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "import_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_column_mappings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      insurance_claims: {
        Row: {
          adjudicated_at: string | null
          adjustment_amount: number | null
          allowed_amount: number | null
          appeal_deadline: string | null
          billed_amount: number
          claim_number: string | null
          claim_type: string
          contract_id: string | null
          created_at: string
          created_by: string | null
          denial_code: string | null
          denial_reason: string | null
          diagnosis_codes: string[]
          encounter_id: string | null
          hospital_id: string
          id: string
          insurer_id: string | null
          insurer_name: string
          invoice_id: string | null
          is_deleted: boolean | null
          metadata: Json
          paid_amount: number | null
          paid_at: string | null
          patient_id: string
          patient_responsibility: number | null
          payer_claim_id: string | null
          primary_icd11: string | null
          prior_auth_number: string | null
          procedure_codes: string[]
          resubmission_count: number
          service_from: string
          service_to: string
          status: string
          submitted_at: string | null
          submitted_by: string | null
          tenant_id: string | null
          updated_at: string
          version: number
        }
        Insert: {
          adjudicated_at?: string | null
          adjustment_amount?: number | null
          allowed_amount?: number | null
          appeal_deadline?: string | null
          billed_amount?: number
          claim_number?: string | null
          claim_type?: string
          contract_id?: string | null
          created_at?: string
          created_by?: string | null
          denial_code?: string | null
          denial_reason?: string | null
          diagnosis_codes?: string[]
          encounter_id?: string | null
          hospital_id: string
          id?: string
          insurer_id?: string | null
          insurer_name: string
          invoice_id?: string | null
          is_deleted?: boolean | null
          metadata?: Json
          paid_amount?: number | null
          paid_at?: string | null
          patient_id: string
          patient_responsibility?: number | null
          payer_claim_id?: string | null
          primary_icd11?: string | null
          prior_auth_number?: string | null
          procedure_codes?: string[]
          resubmission_count?: number
          service_from: string
          service_to: string
          status?: string
          submitted_at?: string | null
          submitted_by?: string | null
          tenant_id?: string | null
          updated_at?: string
          version?: number
        }
        Update: {
          adjudicated_at?: string | null
          adjustment_amount?: number | null
          allowed_amount?: number | null
          appeal_deadline?: string | null
          billed_amount?: number
          claim_number?: string | null
          claim_type?: string
          contract_id?: string | null
          created_at?: string
          created_by?: string | null
          denial_code?: string | null
          denial_reason?: string | null
          diagnosis_codes?: string[]
          encounter_id?: string | null
          hospital_id?: string
          id?: string
          insurer_id?: string | null
          insurer_name?: string
          invoice_id?: string | null
          is_deleted?: boolean | null
          metadata?: Json
          paid_amount?: number | null
          paid_at?: string | null
          patient_id?: string
          patient_responsibility?: number | null
          payer_claim_id?: string | null
          primary_icd11?: string | null
          prior_auth_number?: string | null
          procedure_codes?: string[]
          resubmission_count?: number
          service_from?: string
          service_to?: string
          status?: string
          submitted_at?: string | null
          submitted_by?: string | null
          tenant_id?: string | null
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "insurance_claims_contract_id_fkey"
            columns: ["contract_id"]
            isOneToOne: false
            referencedRelation: "payer_contracts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "insurance_claims_encounter_id_fkey"
            columns: ["encounter_id"]
            isOneToOne: false
            referencedRelation: "encounters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "insurance_claims_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "insurance_claims_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "billing_invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "insurance_claims_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "insurance_claims_submitted_by_fkey"
            columns: ["submitted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "insurance_claims_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_items: {
        Row: {
          atc_code: string | null
          brand_name: string | null
          created_at: string
          created_by: string | null
          currency: string
          form: string
          generic_name: string
          id: string
          is_active: boolean
          is_deleted: boolean | null
          reorder_level: number
          strength: string | null
          tenant_id: string | null
          unit_of_measure: string
          unit_price: number
          updated_at: string
        }
        Insert: {
          atc_code?: string | null
          brand_name?: string | null
          created_at?: string
          created_by?: string | null
          currency?: string
          form: string
          generic_name: string
          id?: string
          is_active?: boolean
          is_deleted?: boolean | null
          reorder_level?: number
          strength?: string | null
          tenant_id?: string | null
          unit_of_measure: string
          unit_price?: number
          updated_at?: string
        }
        Update: {
          atc_code?: string | null
          brand_name?: string | null
          created_at?: string
          created_by?: string | null
          currency?: string
          form?: string
          generic_name?: string
          id?: string
          is_active?: boolean
          is_deleted?: boolean | null
          reorder_level?: number
          strength?: string | null
          tenant_id?: string | null
          unit_of_measure?: string
          unit_price?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "inventory_items_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      lab_results: {
        Row: {
          abnormal_flag: string | null
          analyzer: string | null
          code: string | null
          created_at: string
          created_by: string | null
          encounter_id: string
          entered_at: string | null
          entered_by: string | null
          flag: string | null
          id: string
          is_abnormal: boolean
          is_critical: boolean
          is_deleted: boolean | null
          is_synthetic: boolean
          lab_order_id: string
          lab_technician_id: string | null
          loinc_code: string | null
          notes: string | null
          numeric_value: number | null
          patient_id: string
          provenance: string | null
          reference_range: string | null
          released_to_patient_at: string | null
          result_source: string | null
          result_value: string | null
          simulation_run_id: string | null
          status: string | null
          tenant_id: string
          test_name: string
          unit: string | null
          updated_at: string | null
          value: string
          verified_at: string | null
          verified_by: string | null
          version: number
        }
        Insert: {
          abnormal_flag?: string | null
          analyzer?: string | null
          code?: string | null
          created_at?: string
          created_by?: string | null
          encounter_id: string
          entered_at?: string | null
          entered_by?: string | null
          flag?: string | null
          id?: string
          is_abnormal?: boolean
          is_critical?: boolean
          is_deleted?: boolean | null
          is_synthetic?: boolean
          lab_order_id: string
          lab_technician_id?: string | null
          loinc_code?: string | null
          notes?: string | null
          numeric_value?: number | null
          patient_id: string
          provenance?: string | null
          reference_range?: string | null
          released_to_patient_at?: string | null
          result_source?: string | null
          result_value?: string | null
          simulation_run_id?: string | null
          status?: string | null
          tenant_id: string
          test_name: string
          unit?: string | null
          updated_at?: string | null
          value: string
          verified_at?: string | null
          verified_by?: string | null
          version?: number
        }
        Update: {
          abnormal_flag?: string | null
          analyzer?: string | null
          code?: string | null
          created_at?: string
          created_by?: string | null
          encounter_id?: string
          entered_at?: string | null
          entered_by?: string | null
          flag?: string | null
          id?: string
          is_abnormal?: boolean
          is_critical?: boolean
          is_deleted?: boolean | null
          is_synthetic?: boolean
          lab_order_id?: string
          lab_technician_id?: string | null
          loinc_code?: string | null
          notes?: string | null
          numeric_value?: number | null
          patient_id?: string
          provenance?: string | null
          reference_range?: string | null
          released_to_patient_at?: string | null
          result_source?: string | null
          result_value?: string | null
          simulation_run_id?: string | null
          status?: string | null
          tenant_id?: string
          test_name?: string
          unit?: string | null
          updated_at?: string | null
          value?: string
          verified_at?: string | null
          verified_by?: string | null
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "lab_results_encounter_id_fkey"
            columns: ["encounter_id"]
            isOneToOne: false
            referencedRelation: "encounters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lab_results_lab_order_tenant_fkey"
            columns: ["lab_order_id", "tenant_id"]
            isOneToOne: false
            referencedRelation: "lab_orders"
            referencedColumns: ["id", "tenant_id"]
          },
          {
            foreignKeyName: "lab_results_lab_technician_id_fkey"
            columns: ["lab_technician_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lab_results_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lab_results_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      live_feed_sessions: {
        Row: {
          encounter_id: string | null
          ended_at: string | null
          hospital_id: string | null
          id: string
          last_ping: string | null
          patient_id: string | null
          started_at: string | null
          status: string | null
          synapse_id: string
          tenant_id: string | null
        }
        Insert: {
          encounter_id?: string | null
          ended_at?: string | null
          hospital_id?: string | null
          id?: string
          last_ping?: string | null
          patient_id?: string | null
          started_at?: string | null
          status?: string | null
          synapse_id: string
          tenant_id?: string | null
        }
        Update: {
          encounter_id?: string | null
          ended_at?: string | null
          hospital_id?: string | null
          id?: string
          last_ping?: string | null
          patient_id?: string | null
          started_at?: string | null
          status?: string | null
          synapse_id?: string
          tenant_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "live_feed_sessions_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "live_feed_sessions_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patient_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      loinc_reference: {
        Row: {
          category: string | null
          created_at: string
          created_by: string | null
          display_name: string
          id: string
          is_deleted: boolean | null
          loinc_code: string
          metadata: Json
          specimen: string | null
          tenant_id: string | null
          unit: string | null
          updated_at: string
        }
        Insert: {
          category?: string | null
          created_at?: string
          created_by?: string | null
          display_name: string
          id?: string
          is_deleted?: boolean | null
          loinc_code: string
          metadata?: Json
          specimen?: string | null
          tenant_id?: string | null
          unit?: string | null
          updated_at?: string
        }
        Update: {
          category?: string | null
          created_at?: string
          created_by?: string | null
          display_name?: string
          id?: string
          is_deleted?: boolean | null
          loinc_code?: string
          metadata?: Json
          specimen?: string | null
          tenant_id?: string | null
          unit?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "loinc_reference_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      maternity_records: {
        Row: {
          created_at: string
          created_by: string | null
          encounter_id: string | null
          gestational_age_weeks: number | null
          gravida: number | null
          id: string
          is_deleted: boolean | null
          notes: string | null
          parity: number | null
          patient_id: string
          plan: Json
          risk_flags: Json
          tenant_id: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          encounter_id?: string | null
          gestational_age_weeks?: number | null
          gravida?: number | null
          id?: string
          is_deleted?: boolean | null
          notes?: string | null
          parity?: number | null
          patient_id: string
          plan?: Json
          risk_flags?: Json
          tenant_id?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          encounter_id?: string | null
          gestational_age_weeks?: number | null
          gravida?: number | null
          id?: string
          is_deleted?: boolean | null
          notes?: string | null
          parity?: number | null
          patient_id?: string
          plan?: Json
          risk_flags?: Json
          tenant_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "maternity_records_encounter_id_fkey"
            columns: ["encounter_id"]
            isOneToOne: false
            referencedRelation: "encounters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "maternity_records_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "maternity_records_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      medical_devices: {
        Row: {
          bed_id: string | null
          calibration_due: string | null
          created_at: string
          created_by: string | null
          department_id: string | null
          device_type: string
          firmware_version: string | null
          hospital_id: string
          id: string
          ip_address: unknown
          is_deleted: boolean | null
          last_seen_at: string | null
          location_tag: string | null
          mac_address: unknown
          manufacturer: string | null
          metadata: Json
          model: string | null
          name: string
          serial_number: string | null
          status: string
          tenant_id: string | null
          updated_at: string
        }
        Insert: {
          bed_id?: string | null
          calibration_due?: string | null
          created_at?: string
          created_by?: string | null
          department_id?: string | null
          device_type: string
          firmware_version?: string | null
          hospital_id: string
          id?: string
          ip_address?: unknown
          is_deleted?: boolean | null
          last_seen_at?: string | null
          location_tag?: string | null
          mac_address?: unknown
          manufacturer?: string | null
          metadata?: Json
          model?: string | null
          name: string
          serial_number?: string | null
          status?: string
          tenant_id?: string | null
          updated_at?: string
        }
        Update: {
          bed_id?: string | null
          calibration_due?: string | null
          created_at?: string
          created_by?: string | null
          department_id?: string | null
          device_type?: string
          firmware_version?: string | null
          hospital_id?: string
          id?: string
          ip_address?: unknown
          is_deleted?: boolean | null
          last_seen_at?: string | null
          location_tag?: string | null
          mac_address?: unknown
          manufacturer?: string | null
          metadata?: Json
          model?: string | null
          name?: string
          serial_number?: string | null
          status?: string
          tenant_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "medical_devices_bed_id_fkey"
            columns: ["bed_id"]
            isOneToOne: false
            referencedRelation: "hospital_beds"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "medical_devices_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "medical_devices_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "medical_devices_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      medication_safety_checks: {
        Row: {
          alert_count: number
          alerts_raised: Json
          checked_at: string
          created_at: string
          created_by: string | null
          drug_orders: Json
          encounter_id: string | null
          hospital_id: string | null
          id: string
          is_deleted: boolean | null
          override_by: string | null
          override_reason: string | null
          patient_id: string
          pharmacist_id: string | null
          tenant_id: string | null
          updated_at: string | null
          was_overridden: boolean
        }
        Insert: {
          alert_count?: number
          alerts_raised?: Json
          checked_at?: string
          created_at?: string
          created_by?: string | null
          drug_orders?: Json
          encounter_id?: string | null
          hospital_id?: string | null
          id?: string
          is_deleted?: boolean | null
          override_by?: string | null
          override_reason?: string | null
          patient_id: string
          pharmacist_id?: string | null
          tenant_id?: string | null
          updated_at?: string | null
          was_overridden?: boolean
        }
        Update: {
          alert_count?: number
          alerts_raised?: Json
          checked_at?: string
          created_at?: string
          created_by?: string | null
          drug_orders?: Json
          encounter_id?: string | null
          hospital_id?: string | null
          id?: string
          is_deleted?: boolean | null
          override_by?: string | null
          override_reason?: string | null
          patient_id?: string
          pharmacist_id?: string | null
          tenant_id?: string | null
          updated_at?: string | null
          was_overridden?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "medication_safety_checks_encounter_id_fkey"
            columns: ["encounter_id"]
            isOneToOne: false
            referencedRelation: "encounters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "medication_safety_checks_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "medication_safety_checks_override_by_fkey"
            columns: ["override_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "medication_safety_checks_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "medication_safety_checks_pharmacist_id_fkey"
            columns: ["pharmacist_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "medication_safety_checks_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      menstrual_cycles: {
        Row: {
          created_at: string | null
          cycle_end: string | null
          cycle_start: string
          flow_intensity: string | null
          id: string
          notes: string | null
          period_end: string | null
          period_start: string
          symptoms: string[] | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string | null
          cycle_end?: string | null
          cycle_start: string
          flow_intensity?: string | null
          id?: string
          notes?: string | null
          period_end?: string | null
          period_start: string
          symptoms?: string[] | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string | null
          cycle_end?: string | null
          cycle_start?: string
          flow_intensity?: string | null
          id?: string
          notes?: string | null
          period_end?: string | null
          period_start?: string
          symptoms?: string[] | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      mfa_enrollments: {
        Row: {
          backup_codes: string[] | null
          created_at: string | null
          id: string
          last_used_at: string | null
          secret: string
          user_id: string | null
          verified: boolean | null
        }
        Insert: {
          backup_codes?: string[] | null
          created_at?: string | null
          id?: string
          last_used_at?: string | null
          secret: string
          user_id?: string | null
          verified?: boolean | null
        }
        Update: {
          backup_codes?: string[] | null
          created_at?: string | null
          id?: string
          last_used_at?: string | null
          secret?: string
          user_id?: string | null
          verified?: boolean | null
        }
        Relationships: []
      }
      newsletter_subscribers: {
        Row: {
          created_at: string
          email: string
          id: string
          source: string | null
          subscribed: boolean
          subscribed_at: string
          unsubscribed_at: string | null
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          source?: string | null
          subscribed?: boolean
          subscribed_at?: string
          unsubscribed_at?: string | null
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          source?: string | null
          subscribed?: boolean
          subscribed_at?: string
          unsubscribed_at?: string | null
        }
        Relationships: []
      }
      nin_access_log: {
        Row: {
          accessed_by: string
          action: string
          created_at: string
          created_by: string | null
          hospital_id: string
          id: string
          ip_address: string | null
          is_deleted: boolean | null
          result: string | null
          tenant_id: string | null
          updated_at: string | null
        }
        Insert: {
          accessed_by: string
          action: string
          created_at?: string
          created_by?: string | null
          hospital_id: string
          id?: string
          ip_address?: string | null
          is_deleted?: boolean | null
          result?: string | null
          tenant_id?: string | null
          updated_at?: string | null
        }
        Update: {
          accessed_by?: string
          action?: string
          created_at?: string
          created_by?: string | null
          hospital_id?: string
          id?: string
          ip_address?: string | null
          is_deleted?: boolean | null
          result?: string | null
          tenant_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "nin_access_log_accessed_by_fkey"
            columns: ["accessed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "nin_access_log_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "nin_access_log_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          is_deleted: boolean | null
          is_read: boolean
          message: string
          metadata: Json
          priority: string
          tenant_id: string | null
          title: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          is_deleted?: boolean | null
          is_read?: boolean
          message: string
          metadata?: Json
          priority?: string
          tenant_id?: string | null
          title: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          is_deleted?: boolean | null
          is_read?: boolean
          message?: string
          metadata?: Json
          priority?: string
          tenant_id?: string | null
          title?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      order_items: {
        Row: {
          created_at: string | null
          created_by: string | null
          id: string
          is_deleted: boolean | null
          order_id: string | null
          price_at_time: number
          product_id: string | null
          quantity: number
          tenant_id: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          created_by?: string | null
          id?: string
          is_deleted?: boolean | null
          order_id?: string | null
          price_at_time: number
          product_id?: string | null
          quantity: number
          tenant_id?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          created_by?: string | null
          id?: string
          is_deleted?: boolean | null
          order_id?: string | null
          price_at_time?: number
          product_id?: string | null
          quantity?: number
          tenant_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "order_items_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      order_mappings: {
        Row: {
          atc_codes: string[] | null
          created_at: string
          created_by: string | null
          icd_code: string
          id: string
          is_deleted: boolean | null
          loinc_codes: string[] | null
          tenant_id: string | null
          updated_at: string | null
        }
        Insert: {
          atc_codes?: string[] | null
          created_at?: string
          created_by?: string | null
          icd_code: string
          id?: string
          is_deleted?: boolean | null
          loinc_codes?: string[] | null
          tenant_id?: string | null
          updated_at?: string | null
        }
        Update: {
          atc_codes?: string[] | null
          created_at?: string
          created_by?: string | null
          icd_code?: string
          id?: string
          is_deleted?: boolean | null
          loinc_codes?: string[] | null
          tenant_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "order_mappings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      orders: {
        Row: {
          created_at: string | null
          created_by: string | null
          customer_id: string | null
          delivery_address: string
          delivery_fee: number | null
          id: string
          is_deleted: boolean | null
          lat: number | null
          lng: number | null
          restaurant_id: string | null
          rider_token: string | null
          status: string | null
          tenant_id: string | null
          total_amount: number
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          created_by?: string | null
          customer_id?: string | null
          delivery_address: string
          delivery_fee?: number | null
          id?: string
          is_deleted?: boolean | null
          lat?: number | null
          lng?: number | null
          restaurant_id?: string | null
          rider_token?: string | null
          status?: string | null
          tenant_id?: string | null
          total_amount: number
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          created_by?: string | null
          customer_id?: string | null
          delivery_address?: string
          delivery_fee?: number | null
          id?: string
          is_deleted?: boolean | null
          lat?: number | null
          lng?: number | null
          restaurant_id?: string | null
          rider_token?: string | null
          status?: string | null
          tenant_id?: string | null
          total_amount?: number
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "orders_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      outreach_campaigns: {
        Row: {
          budget: number | null
          campaign_type: string
          created_at: string
          created_by: string | null
          end_date: string | null
          hospital_id: string
          id: string
          is_deleted: boolean | null
          name: string
          notes: string | null
          reached_count: number
          start_date: string
          status: string
          target_age_from: number | null
          target_age_to: number | null
          target_count: number | null
          target_district: string | null
          target_gender: string | null
          target_sub_county: string | null
          tenant_id: string | null
          updated_at: string
        }
        Insert: {
          budget?: number | null
          campaign_type: string
          created_at?: string
          created_by?: string | null
          end_date?: string | null
          hospital_id: string
          id?: string
          is_deleted?: boolean | null
          name: string
          notes?: string | null
          reached_count?: number
          start_date: string
          status?: string
          target_age_from?: number | null
          target_age_to?: number | null
          target_count?: number | null
          target_district?: string | null
          target_gender?: string | null
          target_sub_county?: string | null
          tenant_id?: string | null
          updated_at?: string
        }
        Update: {
          budget?: number | null
          campaign_type?: string
          created_at?: string
          created_by?: string | null
          end_date?: string | null
          hospital_id?: string
          id?: string
          is_deleted?: boolean | null
          name?: string
          notes?: string | null
          reached_count?: number
          start_date?: string
          status?: string
          target_age_from?: number | null
          target_age_to?: number | null
          target_count?: number | null
          target_district?: string | null
          target_gender?: string | null
          target_sub_county?: string | null
          tenant_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "outreach_campaigns_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "outreach_campaigns_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "outreach_campaigns_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      partograph_records: {
        Row: {
          admission_time: string | null
          apgar_1min: number | null
          apgar_5min: number | null
          birth_weight_grams: number | null
          complications: string | null
          created_at: string | null
          delivery_time: string | null
          delivery_type: string | null
          doctor_id: string | null
          entries: Json
          id: string
          midwife_id: string | null
          patient_id: string
          tenant_id: string
        }
        Insert: {
          admission_time?: string | null
          apgar_1min?: number | null
          apgar_5min?: number | null
          birth_weight_grams?: number | null
          complications?: string | null
          created_at?: string | null
          delivery_time?: string | null
          delivery_type?: string | null
          doctor_id?: string | null
          entries?: Json
          id?: string
          midwife_id?: string | null
          patient_id: string
          tenant_id: string
        }
        Update: {
          admission_time?: string | null
          apgar_1min?: number | null
          apgar_5min?: number | null
          birth_weight_grams?: number | null
          complications?: string | null
          created_at?: string | null
          delivery_time?: string | null
          delivery_type?: string | null
          doctor_id?: string | null
          entries?: Json
          id?: string
          midwife_id?: string | null
          patient_id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "partograph_records_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      passport_access_log: {
        Row: {
          access_type: string | null
          accessed_by_hospital_id: string | null
          accessed_by_user_id: string | null
          created_at: string | null
          id: string
          share_token: string | null
          synapse_id: string
        }
        Insert: {
          access_type?: string | null
          accessed_by_hospital_id?: string | null
          accessed_by_user_id?: string | null
          created_at?: string | null
          id?: string
          share_token?: string | null
          synapse_id: string
        }
        Update: {
          access_type?: string | null
          accessed_by_hospital_id?: string | null
          accessed_by_user_id?: string | null
          created_at?: string | null
          id?: string
          share_token?: string | null
          synapse_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "passport_access_log_accessed_by_hospital_id_fkey"
            columns: ["accessed_by_hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
        ]
      }
      passport_share_tokens: {
        Row: {
          created_at: string | null
          created_by: string | null
          expires_at: string | null
          granted_to_hospital_id: string | null
          id: string
          is_revoked: boolean | null
          max_uses: number | null
          scope: string[] | null
          synapse_id: string
          token: string
          token_type: string | null
          use_count: number | null
        }
        Insert: {
          created_at?: string | null
          created_by?: string | null
          expires_at?: string | null
          granted_to_hospital_id?: string | null
          id?: string
          is_revoked?: boolean | null
          max_uses?: number | null
          scope?: string[] | null
          synapse_id: string
          token?: string
          token_type?: string | null
          use_count?: number | null
        }
        Update: {
          created_at?: string | null
          created_by?: string | null
          expires_at?: string | null
          granted_to_hospital_id?: string | null
          id?: string
          is_revoked?: boolean | null
          max_uses?: number | null
          scope?: string[] | null
          synapse_id?: string
          token?: string
          token_type?: string | null
          use_count?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "passport_share_tokens_granted_to_hospital_id_fkey"
            columns: ["granted_to_hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
        ]
      }
      pathway_alerts: {
        Row: {
          created_at: string | null
          created_by: string | null
          hospital_id: string | null
          id: string
          is_deleted: boolean | null
          message: string
          metadata: Json
          pathway_id: string
          patient_id: string
          resolved_at: string | null
          resolved_by: string | null
          rule_name: string
          severity: string
          status: string
          tenant_id: string | null
          triggered_at: string
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          created_by?: string | null
          hospital_id?: string | null
          id?: string
          is_deleted?: boolean | null
          message: string
          metadata?: Json
          pathway_id: string
          patient_id: string
          resolved_at?: string | null
          resolved_by?: string | null
          rule_name: string
          severity?: string
          status?: string
          tenant_id?: string | null
          triggered_at?: string
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          created_by?: string | null
          hospital_id?: string | null
          id?: string
          is_deleted?: boolean | null
          message?: string
          metadata?: Json
          pathway_id?: string
          patient_id?: string
          resolved_at?: string | null
          resolved_by?: string | null
          rule_name?: string
          severity?: string
          status?: string
          tenant_id?: string | null
          triggered_at?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pathway_alerts_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pathway_alerts_pathway_id_fkey"
            columns: ["pathway_id"]
            isOneToOne: false
            referencedRelation: "patient_pathways"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pathway_alerts_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pathway_alerts_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pathway_alerts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      pathway_checklist_items: {
        Row: {
          completed_at: string | null
          completed_by: string | null
          created_at: string
          created_by: string | null
          id: string
          is_deleted: boolean | null
          item_type: string
          metadata: Json
          notes: string | null
          pathway_id: string
          skipped_reason: string | null
          status: string
          step_order: number
          tenant_id: string | null
          title: string
          updated_at: string | null
        }
        Insert: {
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          is_deleted?: boolean | null
          item_type?: string
          metadata?: Json
          notes?: string | null
          pathway_id: string
          skipped_reason?: string | null
          status?: string
          step_order: number
          tenant_id?: string | null
          title: string
          updated_at?: string | null
        }
        Update: {
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          is_deleted?: boolean | null
          item_type?: string
          metadata?: Json
          notes?: string | null
          pathway_id?: string
          skipped_reason?: string | null
          status?: string
          step_order?: number
          tenant_id?: string | null
          title?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pathway_checklist_items_completed_by_fkey"
            columns: ["completed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pathway_checklist_items_pathway_id_fkey"
            columns: ["pathway_id"]
            isOneToOne: false
            referencedRelation: "patient_pathways"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pathway_checklist_items_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      patient_access_grants: {
        Row: {
          access_level: string
          created_at: string
          created_by: string | null
          granted_by: string | null
          granted_to: string
          id: string
          is_deleted: boolean | null
          module_name: string
          patient_id: string
          reason: string
          revoked_at: string | null
          revoked_by: string | null
          status: string
          tenant_id: string | null
          updated_at: string
          valid_from: string
          valid_until: string | null
        }
        Insert: {
          access_level?: string
          created_at?: string
          created_by?: string | null
          granted_by?: string | null
          granted_to: string
          id?: string
          is_deleted?: boolean | null
          module_name: string
          patient_id: string
          reason: string
          revoked_at?: string | null
          revoked_by?: string | null
          status?: string
          tenant_id?: string | null
          updated_at?: string
          valid_from?: string
          valid_until?: string | null
        }
        Update: {
          access_level?: string
          created_at?: string
          created_by?: string | null
          granted_by?: string | null
          granted_to?: string
          id?: string
          is_deleted?: boolean | null
          module_name?: string
          patient_id?: string
          reason?: string
          revoked_at?: string | null
          revoked_by?: string | null
          status?: string
          tenant_id?: string | null
          updated_at?: string
          valid_from?: string
          valid_until?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "patient_access_grants_granted_by_fkey"
            columns: ["granted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patient_access_grants_granted_to_fkey"
            columns: ["granted_to"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patient_access_grants_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patient_access_grants_revoked_by_fkey"
            columns: ["revoked_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patient_access_grants_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      patient_allergies: {
        Row: {
          allergen: string
          allergen_type: string
          atc_code: string | null
          created_at: string
          created_by: string | null
          hospital_id: string | null
          id: string
          is_active: boolean
          is_deleted: boolean | null
          notes: string | null
          onset_date: string | null
          patient_id: string
          reaction: string | null
          reported_by: string | null
          severity: string
          tenant_id: string | null
          updated_at: string
          verified: boolean
          verified_by: string | null
        }
        Insert: {
          allergen: string
          allergen_type?: string
          atc_code?: string | null
          created_at?: string
          created_by?: string | null
          hospital_id?: string | null
          id?: string
          is_active?: boolean
          is_deleted?: boolean | null
          notes?: string | null
          onset_date?: string | null
          patient_id: string
          reaction?: string | null
          reported_by?: string | null
          severity?: string
          tenant_id?: string | null
          updated_at?: string
          verified?: boolean
          verified_by?: string | null
        }
        Update: {
          allergen?: string
          allergen_type?: string
          atc_code?: string | null
          created_at?: string
          created_by?: string | null
          hospital_id?: string | null
          id?: string
          is_active?: boolean
          is_deleted?: boolean | null
          notes?: string | null
          onset_date?: string | null
          patient_id?: string
          reaction?: string | null
          reported_by?: string | null
          severity?: string
          tenant_id?: string | null
          updated_at?: string
          verified?: boolean
          verified_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "patient_allergies_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patient_allergies_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patient_allergies_reported_by_fkey"
            columns: ["reported_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patient_allergies_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patient_allergies_verified_by_fkey"
            columns: ["verified_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      patient_billing: {
        Row: {
          amount: number
          created_at: string
          created_by: string | null
          encounter_id: string | null
          id: string
          is_deleted: boolean | null
          item_name: string
          notes: string | null
          patient_id: string | null
          status: string
          tenant_id: string | null
          updated_at: string
        }
        Insert: {
          amount?: number
          created_at?: string
          created_by?: string | null
          encounter_id?: string | null
          id?: string
          is_deleted?: boolean | null
          item_name: string
          notes?: string | null
          patient_id?: string | null
          status?: string
          tenant_id?: string | null
          updated_at?: string
        }
        Update: {
          amount?: number
          created_at?: string
          created_by?: string | null
          encounter_id?: string | null
          id?: string
          is_deleted?: boolean | null
          item_name?: string
          notes?: string | null
          patient_id?: string | null
          status?: string
          tenant_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "patient_billing_encounter_id_fkey"
            columns: ["encounter_id"]
            isOneToOne: false
            referencedRelation: "encounters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patient_billing_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patient_billing_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      patient_consents: {
        Row: {
          collected_by: string | null
          consent_type: string
          created_at: string
          created_by: string | null
          device_info: Json
          expires_at: string | null
          granted_at: string
          hospital_id: string | null
          id: string
          ip_address: unknown
          is_deleted: boolean | null
          language: string
          module_name: string
          notes: string | null
          patient_id: string
          proxy_name: string | null
          proxy_relation: string | null
          signature_blob: string | null
          status: string
          tenant_id: string | null
          updated_at: string
          withdrawn_at: string | null
          witness_id: string | null
        }
        Insert: {
          collected_by?: string | null
          consent_type?: string
          created_at?: string
          created_by?: string | null
          device_info?: Json
          expires_at?: string | null
          granted_at?: string
          hospital_id?: string | null
          id?: string
          ip_address?: unknown
          is_deleted?: boolean | null
          language?: string
          module_name: string
          notes?: string | null
          patient_id: string
          proxy_name?: string | null
          proxy_relation?: string | null
          signature_blob?: string | null
          status?: string
          tenant_id?: string | null
          updated_at?: string
          withdrawn_at?: string | null
          witness_id?: string | null
        }
        Update: {
          collected_by?: string | null
          consent_type?: string
          created_at?: string
          created_by?: string | null
          device_info?: Json
          expires_at?: string | null
          granted_at?: string
          hospital_id?: string | null
          id?: string
          ip_address?: unknown
          is_deleted?: boolean | null
          language?: string
          module_name?: string
          notes?: string | null
          patient_id?: string
          proxy_name?: string | null
          proxy_relation?: string | null
          signature_blob?: string | null
          status?: string
          tenant_id?: string | null
          updated_at?: string
          withdrawn_at?: string | null
          witness_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "patient_consents_collected_by_fkey"
            columns: ["collected_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patient_consents_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patient_consents_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patient_consents_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patient_consents_witness_id_fkey"
            columns: ["witness_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      patient_notes: {
        Row: {
          clinician_id: string
          created_at: string
          created_by: string | null
          encrypted_content: string
          id: string
          is_deleted: boolean | null
          iv: string
          patient_identifier_hash: string
          tenant_id: string | null
          updated_at: string
        }
        Insert: {
          clinician_id: string
          created_at?: string
          created_by?: string | null
          encrypted_content: string
          id?: string
          is_deleted?: boolean | null
          iv: string
          patient_identifier_hash: string
          tenant_id?: string | null
          updated_at?: string
        }
        Update: {
          clinician_id?: string
          created_at?: string
          created_by?: string | null
          encrypted_content?: string
          id?: string
          is_deleted?: boolean | null
          iv?: string
          patient_identifier_hash?: string
          tenant_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "patient_notes_clinician_id_fkey"
            columns: ["clinician_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patient_notes_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      patient_pathways: {
        Row: {
          abandoned_at: string | null
          abandoned_reason: string | null
          assigned_by: string | null
          completed_at: string | null
          created_at: string
          created_by: string | null
          current_step: number
          encounter_id: string | null
          hospital_id: string | null
          id: string
          is_deleted: boolean | null
          overrides: Json
          patient_id: string
          started_at: string
          status: string
          template_id: string
          tenant_id: string | null
          updated_at: string
        }
        Insert: {
          abandoned_at?: string | null
          abandoned_reason?: string | null
          assigned_by?: string | null
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          current_step?: number
          encounter_id?: string | null
          hospital_id?: string | null
          id?: string
          is_deleted?: boolean | null
          overrides?: Json
          patient_id: string
          started_at?: string
          status?: string
          template_id: string
          tenant_id?: string | null
          updated_at?: string
        }
        Update: {
          abandoned_at?: string | null
          abandoned_reason?: string | null
          assigned_by?: string | null
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          current_step?: number
          encounter_id?: string | null
          hospital_id?: string | null
          id?: string
          is_deleted?: boolean | null
          overrides?: Json
          patient_id?: string
          started_at?: string
          status?: string
          template_id?: string
          tenant_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "patient_pathways_assigned_by_fkey"
            columns: ["assigned_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patient_pathways_encounter_id_fkey"
            columns: ["encounter_id"]
            isOneToOne: false
            referencedRelation: "encounters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patient_pathways_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patient_pathways_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patient_pathways_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "clinical_pathway_templates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patient_pathways_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      patient_problem_list: {
        Row: {
          created_at: string
          created_by: string | null
          hospital_id: string | null
          icd11_code: string | null
          icd11_name: string
          id: string
          is_deleted: boolean | null
          onset_date: string | null
          patient_id: string
          resolved_date: string | null
          severity: string | null
          status: string
          tenant_id: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          hospital_id?: string | null
          icd11_code?: string | null
          icd11_name: string
          id?: string
          is_deleted?: boolean | null
          onset_date?: string | null
          patient_id: string
          resolved_date?: string | null
          severity?: string | null
          status?: string
          tenant_id?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          hospital_id?: string | null
          icd11_code?: string | null
          icd11_name?: string
          id?: string
          is_deleted?: boolean | null
          onset_date?: string | null
          patient_id?: string
          resolved_date?: string | null
          severity?: string | null
          status?: string
          tenant_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "patient_problem_list_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patient_problem_list_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patient_problem_list_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patient_problem_list_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      patient_profiles: {
        Row: {
          allergies: Json | null
          blood_group: string | null
          chronic_conditions: Json | null
          created_at: string | null
          current_medications: Json | null
          date_of_birth: string | null
          emergency_contact_name: string | null
          emergency_contact_phone: string | null
          first_name: string | null
          full_name: string
          hospital_id: string | null
          id: string
          identity_consent: boolean | null
          immunizations: Json | null
          last_name: string | null
          national_id: string | null
          passport_pin_hash: string | null
          phone: string | null
          sex: string | null
          synapse_id: string | null
          unregistered_hospital: string | null
          updated_at: string | null
        }
        Insert: {
          allergies?: Json | null
          blood_group?: string | null
          chronic_conditions?: Json | null
          created_at?: string | null
          current_medications?: Json | null
          date_of_birth?: string | null
          emergency_contact_name?: string | null
          emergency_contact_phone?: string | null
          first_name?: string | null
          full_name: string
          hospital_id?: string | null
          id: string
          identity_consent?: boolean | null
          immunizations?: Json | null
          last_name?: string | null
          national_id?: string | null
          passport_pin_hash?: string | null
          phone?: string | null
          sex?: string | null
          synapse_id?: string | null
          unregistered_hospital?: string | null
          updated_at?: string | null
        }
        Update: {
          allergies?: Json | null
          blood_group?: string | null
          chronic_conditions?: Json | null
          created_at?: string | null
          current_medications?: Json | null
          date_of_birth?: string | null
          emergency_contact_name?: string | null
          emergency_contact_phone?: string | null
          first_name?: string | null
          full_name?: string
          hospital_id?: string | null
          id?: string
          identity_consent?: boolean | null
          immunizations?: Json | null
          last_name?: string | null
          national_id?: string | null
          passport_pin_hash?: string | null
          phone?: string | null
          sex?: string | null
          synapse_id?: string | null
          unregistered_hospital?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "patient_profiles_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
        ]
      }
      patient_safety_events: {
        Row: {
          acknowledged_by: string | null
          created_at: string
          created_by: string | null
          description: string
          encounter_id: string
          encounter_order_id: string | null
          event_type: string
          id: string
          is_deleted: boolean | null
          severity: string
          tenant_id: string | null
          updated_at: string | null
        }
        Insert: {
          acknowledged_by?: string | null
          created_at?: string
          created_by?: string | null
          description: string
          encounter_id: string
          encounter_order_id?: string | null
          event_type: string
          id?: string
          is_deleted?: boolean | null
          severity: string
          tenant_id?: string | null
          updated_at?: string | null
        }
        Update: {
          acknowledged_by?: string | null
          created_at?: string
          created_by?: string | null
          description?: string
          encounter_id?: string
          encounter_order_id?: string | null
          event_type?: string
          id?: string
          is_deleted?: boolean | null
          severity?: string
          tenant_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "patient_safety_events_acknowledged_by_fkey"
            columns: ["acknowledged_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patient_safety_events_encounter_id_fkey"
            columns: ["encounter_id"]
            isOneToOne: false
            referencedRelation: "encounters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patient_safety_events_encounter_order_id_fkey"
            columns: ["encounter_order_id"]
            isOneToOne: false
            referencedRelation: "encounter_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patient_safety_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      patient_sms_reminders: {
        Row: {
          campaign_id: string | null
          created_at: string
          created_by: string | null
          error_message: string | null
          hospital_id: string | null
          id: string
          is_deleted: boolean | null
          language: string
          message_body: string
          message_type: string
          patient_id: string
          phone_number: string
          provider: string
          provider_message_id: string | null
          retry_count: number
          scheduled_at: string
          sent_at: string | null
          status: string
          tenant_id: string | null
          updated_at: string
        }
        Insert: {
          campaign_id?: string | null
          created_at?: string
          created_by?: string | null
          error_message?: string | null
          hospital_id?: string | null
          id?: string
          is_deleted?: boolean | null
          language?: string
          message_body: string
          message_type: string
          patient_id: string
          phone_number: string
          provider?: string
          provider_message_id?: string | null
          retry_count?: number
          scheduled_at: string
          sent_at?: string | null
          status?: string
          tenant_id?: string | null
          updated_at?: string
        }
        Update: {
          campaign_id?: string | null
          created_at?: string
          created_by?: string | null
          error_message?: string | null
          hospital_id?: string | null
          id?: string
          is_deleted?: boolean | null
          language?: string
          message_body?: string
          message_type?: string
          patient_id?: string
          phone_number?: string
          provider?: string
          provider_message_id?: string | null
          retry_count?: number
          scheduled_at?: string
          sent_at?: string | null
          status?: string
          tenant_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "patient_sms_reminders_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "outreach_campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patient_sms_reminders_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patient_sms_reminders_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patient_sms_reminders_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      patient_timeline_events: {
        Row: {
          created_at: string
          created_by: string | null
          event_date: string
          event_type: string
          hospital_id: string | null
          id: string
          is_deleted: boolean | null
          patient_id: string
          payload: Json
          severity: string | null
          source_id: string | null
          source_table: string | null
          summary: string | null
          tags: string[]
          tenant_id: string | null
          title: string
          updated_at: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          event_date?: string
          event_type: string
          hospital_id?: string | null
          id?: string
          is_deleted?: boolean | null
          patient_id: string
          payload?: Json
          severity?: string | null
          source_id?: string | null
          source_table?: string | null
          summary?: string | null
          tags?: string[]
          tenant_id?: string | null
          title: string
          updated_at?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          event_date?: string
          event_type?: string
          hospital_id?: string | null
          id?: string
          is_deleted?: boolean | null
          patient_id?: string
          payload?: Json
          severity?: string | null
          source_id?: string | null
          source_table?: string | null
          summary?: string | null
          tags?: string[]
          tenant_id?: string | null
          title?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "patient_timeline_events_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patient_timeline_events_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patient_timeline_events_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patient_timeline_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      patient_timeline_pins: {
        Row: {
          created_at: string
          created_by: string | null
          event_id: string
          id: string
          is_deleted: boolean | null
          note: string | null
          patient_id: string
          pinned_by: string
          tenant_id: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          event_id: string
          id?: string
          is_deleted?: boolean | null
          note?: string | null
          patient_id: string
          pinned_by: string
          tenant_id?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          event_id?: string
          id?: string
          is_deleted?: boolean | null
          note?: string | null
          patient_id?: string
          pinned_by?: string
          tenant_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "patient_timeline_pins_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "patient_timeline_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patient_timeline_pins_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patient_timeline_pins_pinned_by_fkey"
            columns: ["pinned_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patient_timeline_pins_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      patient_vitals: {
        Row: {
          blood_glucose: number | null
          created_at: string | null
          device_id: string | null
          diastolic_bp: number | null
          encounter_id: string | null
          heart_rate: number | null
          id: string
          is_live_feed: boolean | null
          patient_id: string | null
          recorded_at: string | null
          respiratory_rate: number | null
          source: string | null
          spo2: number | null
          synapse_id: string | null
          systolic_bp: number | null
          temperature: number | null
          weight_kg: number | null
        }
        Insert: {
          blood_glucose?: number | null
          created_at?: string | null
          device_id?: string | null
          diastolic_bp?: number | null
          encounter_id?: string | null
          heart_rate?: number | null
          id?: string
          is_live_feed?: boolean | null
          patient_id?: string | null
          recorded_at?: string | null
          respiratory_rate?: number | null
          source?: string | null
          spo2?: number | null
          synapse_id?: string | null
          systolic_bp?: number | null
          temperature?: number | null
          weight_kg?: number | null
        }
        Update: {
          blood_glucose?: number | null
          created_at?: string | null
          device_id?: string | null
          diastolic_bp?: number | null
          encounter_id?: string | null
          heart_rate?: number | null
          id?: string
          is_live_feed?: boolean | null
          patient_id?: string | null
          recorded_at?: string | null
          respiratory_rate?: number | null
          source?: string | null
          spo2?: number | null
          synapse_id?: string | null
          systolic_bp?: number | null
          temperature?: number | null
          weight_kg?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "patient_vitals_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patient_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      patients: {
        Row: {
          allergies: Json
          blood_group: string | null
          chronic_conditions: Json
          created_at: string
          created_by: string | null
          current_medications: Json
          disability_status: string | null
          district: string | null
          dob: string | null
          education_level: string | null
          employment_status: string | null
          ethnicity: string | null
          family_history: Json
          full_name: string | null
          full_name_hash: string | null
          height_cm: number | null
          hospital_id: string | null
          id: string
          income_bracket: string | null
          is_deleted: boolean | null
          is_pregnant: boolean
          mrn: string
          nin: string | null
          nin_hash: string | null
          nin_last4: string | null
          phone: string | null
          phone_hash: string | null
          phone_last4: string | null
          sex: string | null
          social_history: Json
          tenant_id: string | null
          uhid: string | null
          updated_at: string
          village: string | null
          weight_kg: number | null
        }
        Insert: {
          allergies?: Json
          blood_group?: string | null
          chronic_conditions?: Json
          created_at?: string
          created_by?: string | null
          current_medications?: Json
          disability_status?: string | null
          district?: string | null
          dob?: string | null
          education_level?: string | null
          employment_status?: string | null
          ethnicity?: string | null
          family_history?: Json
          full_name?: string | null
          full_name_hash?: string | null
          height_cm?: number | null
          hospital_id?: string | null
          id?: string
          income_bracket?: string | null
          is_deleted?: boolean | null
          is_pregnant?: boolean
          mrn: string
          nin?: string | null
          nin_hash?: string | null
          nin_last4?: string | null
          phone?: string | null
          phone_hash?: string | null
          phone_last4?: string | null
          sex?: string | null
          social_history?: Json
          tenant_id?: string | null
          uhid?: string | null
          updated_at?: string
          village?: string | null
          weight_kg?: number | null
        }
        Update: {
          allergies?: Json
          blood_group?: string | null
          chronic_conditions?: Json
          created_at?: string
          created_by?: string | null
          current_medications?: Json
          disability_status?: string | null
          district?: string | null
          dob?: string | null
          education_level?: string | null
          employment_status?: string | null
          ethnicity?: string | null
          family_history?: Json
          full_name?: string | null
          full_name_hash?: string | null
          height_cm?: number | null
          hospital_id?: string | null
          id?: string
          income_bracket?: string | null
          is_deleted?: boolean | null
          is_pregnant?: boolean
          mrn?: string
          nin?: string | null
          nin_hash?: string | null
          nin_last4?: string | null
          phone?: string | null
          phone_hash?: string | null
          phone_last4?: string | null
          sex?: string | null
          social_history?: Json
          tenant_id?: string | null
          uhid?: string | null
          updated_at?: string
          village?: string | null
          weight_kg?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "patients_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patients_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      payer_contracts: {
        Row: {
          api_endpoint: string | null
          api_key_ref: string | null
          clean_claim_rate_target: number
          contract_number: string | null
          contract_type: string
          created_at: string
          created_by: string | null
          effective_date: string
          expiry_date: string | null
          hospital_id: string
          id: string
          insurer_id: string | null
          insurer_name: string
          is_active: boolean
          is_deleted: boolean | null
          metadata: Json
          notes: string | null
          submission_method: string
          tenant_id: string | null
          timely_filing_days: number
          updated_at: string
        }
        Insert: {
          api_endpoint?: string | null
          api_key_ref?: string | null
          clean_claim_rate_target?: number
          contract_number?: string | null
          contract_type?: string
          created_at?: string
          created_by?: string | null
          effective_date: string
          expiry_date?: string | null
          hospital_id: string
          id?: string
          insurer_id?: string | null
          insurer_name: string
          is_active?: boolean
          is_deleted?: boolean | null
          metadata?: Json
          notes?: string | null
          submission_method?: string
          tenant_id?: string | null
          timely_filing_days?: number
          updated_at?: string
        }
        Update: {
          api_endpoint?: string | null
          api_key_ref?: string | null
          clean_claim_rate_target?: number
          contract_number?: string | null
          contract_type?: string
          created_at?: string
          created_by?: string | null
          effective_date?: string
          expiry_date?: string | null
          hospital_id?: string
          id?: string
          insurer_id?: string | null
          insurer_name?: string
          is_active?: boolean
          is_deleted?: boolean | null
          metadata?: Json
          notes?: string | null
          submission_method?: string
          tenant_id?: string | null
          timely_filing_days?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payer_contracts_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payer_contracts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      pediatric_growth_records: {
        Row: {
          age_months: number
          created_at: string | null
          created_by: string | null
          head_circumference_cm: number | null
          height_cm: number | null
          id: string
          is_deleted: boolean | null
          patient_id: string
          recorded_at: string
          recorded_by: string | null
          tenant_id: string | null
          updated_at: string | null
          weight_kg: number | null
        }
        Insert: {
          age_months: number
          created_at?: string | null
          created_by?: string | null
          head_circumference_cm?: number | null
          height_cm?: number | null
          id?: string
          is_deleted?: boolean | null
          patient_id: string
          recorded_at?: string
          recorded_by?: string | null
          tenant_id?: string | null
          updated_at?: string | null
          weight_kg?: number | null
        }
        Update: {
          age_months?: number
          created_at?: string | null
          created_by?: string | null
          head_circumference_cm?: number | null
          height_cm?: number | null
          id?: string
          is_deleted?: boolean | null
          patient_id?: string
          recorded_at?: string
          recorded_by?: string | null
          tenant_id?: string | null
          updated_at?: string | null
          weight_kg?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "pediatric_growth_records_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pediatric_growth_records_recorded_by_fkey"
            columns: ["recorded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pediatric_growth_records_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      pharmacy_accounting_periods: {
        Row: {
          close_snapshot: Json
          closed_at: string | null
          closed_by: string | null
          created_at: string
          id: string
          period_end: string
          period_start: string
          status: string
          tenant_id: string
        }
        Insert: {
          close_snapshot?: Json
          closed_at?: string | null
          closed_by?: string | null
          created_at?: string
          id?: string
          period_end: string
          period_start: string
          status?: string
          tenant_id: string
        }
        Update: {
          close_snapshot?: Json
          closed_at?: string | null
          closed_by?: string | null
          created_at?: string
          id?: string
          period_end?: string
          period_start?: string
          status?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "pharmacy_accounting_periods_closed_by_fkey"
            columns: ["closed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pharmacy_accounting_periods_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      pharmacy_audit_logs: {
        Row: {
          action: string
          created_at: string | null
          details: string | null
          entity: string
          entity_id: string | null
          id: string
          ip_address: string | null
          profile_id: string
          tenant_id: string
        }
        Insert: {
          action: string
          created_at?: string | null
          details?: string | null
          entity: string
          entity_id?: string | null
          id?: string
          ip_address?: string | null
          profile_id: string
          tenant_id: string
        }
        Update: {
          action?: string
          created_at?: string | null
          details?: string | null
          entity?: string
          entity_id?: string | null
          id?: string
          ip_address?: string | null
          profile_id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "pharmacy_audit_logs_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pharmacy_audit_logs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      pharmacy_clients: {
        Row: {
          address: string | null
          created_at: string | null
          id: string
          is_active: boolean | null
          last_visit: string | null
          name: string
          notes: string | null
          phone: string | null
          tenant_id: string
          updated_at: string | null
        }
        Insert: {
          address?: string | null
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          last_visit?: string | null
          name: string
          notes?: string | null
          phone?: string | null
          tenant_id: string
          updated_at?: string | null
        }
        Update: {
          address?: string | null
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          last_visit?: string | null
          name?: string
          notes?: string | null
          phone?: string | null
          tenant_id?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pharmacy_clients_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      pharmacy_credit_ledger: {
        Row: {
          amount: number
          balance_after: number
          created_at: string | null
          created_by: string | null
          customer_id: string | null
          due_date: string | null
          id: string
          notes: string | null
          tenant_id: string
          transaction_id: string | null
          type: string
        }
        Insert: {
          amount: number
          balance_after: number
          created_at?: string | null
          created_by?: string | null
          customer_id?: string | null
          due_date?: string | null
          id?: string
          notes?: string | null
          tenant_id: string
          transaction_id?: string | null
          type: string
        }
        Update: {
          amount?: number
          balance_after?: number
          created_at?: string | null
          created_by?: string | null
          customer_id?: string | null
          due_date?: string | null
          id?: string
          notes?: string | null
          tenant_id?: string
          transaction_id?: string | null
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "pharmacy_credit_ledger_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "pharmacy_customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pharmacy_credit_ledger_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pharmacy_credit_ledger_transaction_id_fkey"
            columns: ["transaction_id"]
            isOneToOne: false
            referencedRelation: "pharmacy_transactions"
            referencedColumns: ["id"]
          },
        ]
      }
      pharmacy_customers: {
        Row: {
          address: string | null
          created_at: string | null
          email: string | null
          id: string
          is_active: boolean | null
          name: string
          password_hash: string | null
          phone: string | null
          tenant_id: string
          updated_at: string | null
        }
        Insert: {
          address?: string | null
          created_at?: string | null
          email?: string | null
          id?: string
          is_active?: boolean | null
          name: string
          password_hash?: string | null
          phone?: string | null
          tenant_id: string
          updated_at?: string | null
        }
        Update: {
          address?: string | null
          created_at?: string | null
          email?: string | null
          id?: string
          is_active?: boolean | null
          name?: string
          password_hash?: string | null
          phone?: string | null
          tenant_id?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pharmacy_customers_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      pharmacy_expenses: {
        Row: {
          amount: number
          category: string
          created_at: string | null
          description: string
          expense_date: string | null
          id: string
          payment_method: string | null
          receipt_url: string | null
          recorded_by: string | null
          tenant_id: string
        }
        Insert: {
          amount: number
          category: string
          created_at?: string | null
          description: string
          expense_date?: string | null
          id?: string
          payment_method?: string | null
          receipt_url?: string | null
          recorded_by?: string | null
          tenant_id: string
        }
        Update: {
          amount?: number
          category?: string
          created_at?: string | null
          description?: string
          expense_date?: string | null
          id?: string
          payment_method?: string | null
          receipt_url?: string | null
          recorded_by?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "pharmacy_expenses_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      pharmacy_import_sessions: {
        Row: {
          ai_mapping: Json | null
          ai_summary: string | null
          completed_at: string | null
          confirmed_at: string | null
          created_at: string | null
          created_by: string | null
          duplicate_rows: number | null
          error_message: string | null
          file_name: string | null
          file_url: string | null
          flagged_rows: number | null
          id: string
          matched_rows: number | null
          source_system: string | null
          status: string | null
          tenant_id: string
          total_rows: number | null
        }
        Insert: {
          ai_mapping?: Json | null
          ai_summary?: string | null
          completed_at?: string | null
          confirmed_at?: string | null
          created_at?: string | null
          created_by?: string | null
          duplicate_rows?: number | null
          error_message?: string | null
          file_name?: string | null
          file_url?: string | null
          flagged_rows?: number | null
          id?: string
          matched_rows?: number | null
          source_system?: string | null
          status?: string | null
          tenant_id: string
          total_rows?: number | null
        }
        Update: {
          ai_mapping?: Json | null
          ai_summary?: string | null
          completed_at?: string | null
          confirmed_at?: string | null
          created_at?: string | null
          created_by?: string | null
          duplicate_rows?: number | null
          error_message?: string | null
          file_name?: string | null
          file_url?: string | null
          flagged_rows?: number | null
          id?: string
          matched_rows?: number | null
          source_system?: string | null
          status?: string | null
          tenant_id?: string
          total_rows?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "pharmacy_import_sessions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      pharmacy_inquiries: {
        Row: {
          admin_response: string | null
          created_at: string | null
          id: string
          message: string
          profile_id: string | null
          responded_at: string | null
          status: string
          subject: string
          tenant_id: string
          type: string
          updated_at: string | null
          user_email: string
          user_name: string
        }
        Insert: {
          admin_response?: string | null
          created_at?: string | null
          id?: string
          message: string
          profile_id?: string | null
          responded_at?: string | null
          status?: string
          subject: string
          tenant_id: string
          type: string
          updated_at?: string | null
          user_email: string
          user_name: string
        }
        Update: {
          admin_response?: string | null
          created_at?: string | null
          id?: string
          message?: string
          profile_id?: string | null
          responded_at?: string | null
          status?: string
          subject?: string
          tenant_id?: string
          type?: string
          updated_at?: string | null
          user_email?: string
          user_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "pharmacy_inquiries_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      pharmacy_network_inventory: {
        Row: {
          brand_name: string | null
          created_at: string
          dosage_form: string | null
          drug_name: string
          generic_name: string | null
          id: string
          is_available: boolean | null
          last_synced_at: string
          pharmacy_tenant_id: string | null
          quantity_in_stock: number
          strength: string | null
          unit_price_ugx: number | null
        }
        Insert: {
          brand_name?: string | null
          created_at?: string
          dosage_form?: string | null
          drug_name: string
          generic_name?: string | null
          id?: string
          is_available?: boolean | null
          last_synced_at?: string
          pharmacy_tenant_id?: string | null
          quantity_in_stock?: number
          strength?: string | null
          unit_price_ugx?: number | null
        }
        Update: {
          brand_name?: string | null
          created_at?: string
          dosage_form?: string | null
          drug_name?: string
          generic_name?: string | null
          id?: string
          is_available?: boolean | null
          last_synced_at?: string
          pharmacy_tenant_id?: string | null
          quantity_in_stock?: number
          strength?: string | null
          unit_price_ugx?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "pharmacy_network_inventory_pharmacy_tenant_id_fkey"
            columns: ["pharmacy_tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      pharmacy_notifications: {
        Row: {
          created_at: string | null
          id: string
          is_read: boolean | null
          message: string
          profile_id: string
          related_id: string | null
          tenant_id: string
          title: string
          type: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          is_read?: boolean | null
          message: string
          profile_id: string
          related_id?: string | null
          tenant_id: string
          title: string
          type: string
        }
        Update: {
          created_at?: string | null
          id?: string
          is_read?: boolean | null
          message?: string
          profile_id?: string
          related_id?: string | null
          tenant_id?: string
          title?: string
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "pharmacy_notifications_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pharmacy_notifications_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      pharmacy_onboarding: {
        Row: {
          account_created_at: string | null
          created_at: string | null
          current_step: number | null
          enrolled_by: string | null
          first_product_at: string | null
          id: string
          invite_expires_at: string | null
          invite_sent_at: string | null
          invite_token: string | null
          notes: string | null
          onboarding_completed_at: string | null
          profile_completed_at: string | null
          store_setup_at: string | null
          tenant_id: string
          updated_at: string | null
        }
        Insert: {
          account_created_at?: string | null
          created_at?: string | null
          current_step?: number | null
          enrolled_by?: string | null
          first_product_at?: string | null
          id?: string
          invite_expires_at?: string | null
          invite_sent_at?: string | null
          invite_token?: string | null
          notes?: string | null
          onboarding_completed_at?: string | null
          profile_completed_at?: string | null
          store_setup_at?: string | null
          tenant_id: string
          updated_at?: string | null
        }
        Update: {
          account_created_at?: string | null
          created_at?: string | null
          current_step?: number | null
          enrolled_by?: string | null
          first_product_at?: string | null
          id?: string
          invite_expires_at?: string | null
          invite_sent_at?: string | null
          invite_token?: string | null
          notes?: string | null
          onboarding_completed_at?: string | null
          profile_completed_at?: string | null
          store_setup_at?: string | null
          tenant_id?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pharmacy_onboarding_enrolled_by_fkey"
            columns: ["enrolled_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pharmacy_onboarding_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      pharmacy_order_items: {
        Row: {
          created_at: string | null
          id: string
          order_id: string
          product_id: string | null
          product_name: string
          quantity: number
          tenant_id: string
          total_price: number
          unit_price: number
        }
        Insert: {
          created_at?: string | null
          id?: string
          order_id: string
          product_id?: string | null
          product_name: string
          quantity: number
          tenant_id: string
          total_price: number
          unit_price: number
        }
        Update: {
          created_at?: string | null
          id?: string
          order_id?: string
          product_id?: string | null
          product_name?: string
          quantity?: number
          tenant_id?: string
          total_price?: number
          unit_price?: number
        }
        Relationships: [
          {
            foreignKeyName: "pharmacy_order_items_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "pharmacy_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pharmacy_order_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "pharmacy_products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pharmacy_order_items_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      pharmacy_orders: {
        Row: {
          claimed_at: string | null
          claimed_by: string | null
          created_at: string | null
          customer_id: string | null
          delivery_address: string | null
          fulfillment_type: string | null
          id: string
          is_online_order: boolean | null
          items: Json
          notes: string | null
          order_no: string
          order_type: string
          patient_id: string | null
          payment_ref: string | null
          payment_status: string
          processed_by: string | null
          status: string
          tenant_id: string
          total_amount: number
          total_ugx: number
          updated_at: string | null
        }
        Insert: {
          claimed_at?: string | null
          claimed_by?: string | null
          created_at?: string | null
          customer_id?: string | null
          delivery_address?: string | null
          fulfillment_type?: string | null
          id?: string
          is_online_order?: boolean | null
          items?: Json
          notes?: string | null
          order_no: string
          order_type?: string
          patient_id?: string | null
          payment_ref?: string | null
          payment_status?: string
          processed_by?: string | null
          status?: string
          tenant_id: string
          total_amount: number
          total_ugx?: number
          updated_at?: string | null
        }
        Update: {
          claimed_at?: string | null
          claimed_by?: string | null
          created_at?: string | null
          customer_id?: string | null
          delivery_address?: string | null
          fulfillment_type?: string | null
          id?: string
          is_online_order?: boolean | null
          items?: Json
          notes?: string | null
          order_no?: string
          order_type?: string
          patient_id?: string | null
          payment_ref?: string | null
          payment_status?: string
          processed_by?: string | null
          status?: string
          tenant_id?: string
          total_amount?: number
          total_ugx?: number
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pharmacy_orders_claimed_by_fkey"
            columns: ["claimed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pharmacy_orders_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "pharmacy_customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pharmacy_orders_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pharmacy_orders_processed_by_fkey"
            columns: ["processed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pharmacy_orders_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      pharmacy_product_batches: {
        Row: {
          batch_number: string
          cost_price: number
          created_at: string | null
          expiry_date: string
          id: string
          initial_quantity: number
          is_active: boolean | null
          notes: string | null
          product_id: string
          quantity: number
          received_date: string | null
          tenant_id: string
          updated_at: string | null
        }
        Insert: {
          batch_number: string
          cost_price: number
          created_at?: string | null
          expiry_date: string
          id?: string
          initial_quantity: number
          is_active?: boolean | null
          notes?: string | null
          product_id: string
          quantity: number
          received_date?: string | null
          tenant_id: string
          updated_at?: string | null
        }
        Update: {
          batch_number?: string
          cost_price?: number
          created_at?: string | null
          expiry_date?: string
          id?: string
          initial_quantity?: number
          is_active?: boolean | null
          notes?: string | null
          product_id?: string
          quantity?: number
          received_date?: string | null
          tenant_id?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pharmacy_product_batches_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "pharmacy_products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pharmacy_product_batches_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      pharmacy_product_packages: {
        Row: {
          created_at: string | null
          id: string
          is_default: boolean | null
          name: string
          price: number
          product_id: string
          tenant_id: string
          units_per_package: number
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          id?: string
          is_default?: boolean | null
          name: string
          price: number
          product_id: string
          tenant_id: string
          units_per_package: number
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          id?: string
          is_default?: boolean | null
          name?: string
          price?: number
          product_id?: string
          tenant_id?: string
          units_per_package?: number
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pharmacy_product_packages_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "pharmacy_products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pharmacy_product_packages_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      pharmacy_products: {
        Row: {
          active_ingredient: string | null
          barcode: string | null
          batch_number: string | null
          category: string
          cost_price: number
          created_at: string | null
          description: string | null
          dosage_form: string | null
          expiry_date: string | null
          generic_name: string | null
          id: string
          is_active: boolean | null
          manufacturer: string | null
          name: string
          price: number
          quantity: number
          regulatory_id: string | null
          reorder_level: number
          requires_prescription: boolean | null
          side_effects: string | null
          sku: string
          storage_instructions: string | null
          strength: string | null
          supplier_id: string | null
          tenant_id: string
          unit_of_measure: string
          updated_at: string | null
        }
        Insert: {
          active_ingredient?: string | null
          barcode?: string | null
          batch_number?: string | null
          category?: string
          cost_price: number
          created_at?: string | null
          description?: string | null
          dosage_form?: string | null
          expiry_date?: string | null
          generic_name?: string | null
          id?: string
          is_active?: boolean | null
          manufacturer?: string | null
          name: string
          price: number
          quantity?: number
          regulatory_id?: string | null
          reorder_level?: number
          requires_prescription?: boolean | null
          side_effects?: string | null
          sku: string
          storage_instructions?: string | null
          strength?: string | null
          supplier_id?: string | null
          tenant_id: string
          unit_of_measure?: string
          updated_at?: string | null
        }
        Update: {
          active_ingredient?: string | null
          barcode?: string | null
          batch_number?: string | null
          category?: string
          cost_price?: number
          created_at?: string | null
          description?: string | null
          dosage_form?: string | null
          expiry_date?: string | null
          generic_name?: string | null
          id?: string
          is_active?: boolean | null
          manufacturer?: string | null
          name?: string
          price?: number
          quantity?: number
          regulatory_id?: string | null
          reorder_level?: number
          requires_prescription?: boolean | null
          side_effects?: string | null
          sku?: string
          storage_instructions?: string | null
          strength?: string | null
          supplier_id?: string | null
          tenant_id?: string
          unit_of_measure?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pharmacy_products_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "pharmacy_suppliers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pharmacy_products_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      pharmacy_profiles: {
        Row: {
          contact_email: string | null
          contact_person: string | null
          contact_phone: string | null
          created_at: string
          custom_domain: string | null
          custom_domain_verified: boolean
          custom_domain_verified_at: string | null
          default_domain: string | null
          delivery_available: boolean
          delivery_radius_km: number | null
          district: string | null
          domain_configured_at: string | null
          domain_error: string | null
          domain_status: string | null
          domain_verification: Json | null
          id: string
          is_network_visible: boolean
          last_domain_check_at: string | null
          license_expiry: string | null
          license_number: string | null
          logo_url: string | null
          migrated_from: string | null
          migration_completed_at: string | null
          migration_status: string
          network_joined_at: string | null
          pharmacy_name: string | null
          physical_address: string | null
          tenant_id: string | null
          theme_color: string
          updated_at: string
          vercel_domain_id: string | null
        }
        Insert: {
          contact_email?: string | null
          contact_person?: string | null
          contact_phone?: string | null
          created_at?: string
          custom_domain?: string | null
          custom_domain_verified?: boolean
          custom_domain_verified_at?: string | null
          default_domain?: string | null
          delivery_available?: boolean
          delivery_radius_km?: number | null
          district?: string | null
          domain_configured_at?: string | null
          domain_error?: string | null
          domain_status?: string | null
          domain_verification?: Json | null
          id?: string
          is_network_visible?: boolean
          last_domain_check_at?: string | null
          license_expiry?: string | null
          license_number?: string | null
          logo_url?: string | null
          migrated_from?: string | null
          migration_completed_at?: string | null
          migration_status?: string
          network_joined_at?: string | null
          pharmacy_name?: string | null
          physical_address?: string | null
          tenant_id?: string | null
          theme_color?: string
          updated_at?: string
          vercel_domain_id?: string | null
        }
        Update: {
          contact_email?: string | null
          contact_person?: string | null
          contact_phone?: string | null
          created_at?: string
          custom_domain?: string | null
          custom_domain_verified?: boolean
          custom_domain_verified_at?: string | null
          default_domain?: string | null
          delivery_available?: boolean
          delivery_radius_km?: number | null
          district?: string | null
          domain_configured_at?: string | null
          domain_error?: string | null
          domain_status?: string | null
          domain_verification?: Json | null
          id?: string
          is_network_visible?: boolean
          last_domain_check_at?: string | null
          license_expiry?: string | null
          license_number?: string | null
          logo_url?: string | null
          migrated_from?: string | null
          migration_completed_at?: string | null
          migration_status?: string
          network_joined_at?: string | null
          pharmacy_name?: string | null
          physical_address?: string | null
          tenant_id?: string | null
          theme_color?: string
          updated_at?: string
          vercel_domain_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pharmacy_profiles_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      pharmacy_purchase_order_items: {
        Row: {
          created_at: string | null
          id: string
          product_id: string | null
          product_name: string
          purchase_order_id: string
          quantity: number
          tenant_id: string
          total_price: number
          unit_price: number
        }
        Insert: {
          created_at?: string | null
          id?: string
          product_id?: string | null
          product_name: string
          purchase_order_id: string
          quantity: number
          tenant_id: string
          total_price: number
          unit_price: number
        }
        Update: {
          created_at?: string | null
          id?: string
          product_id?: string | null
          product_name?: string
          purchase_order_id?: string
          quantity?: number
          tenant_id?: string
          total_price?: number
          unit_price?: number
        }
        Relationships: [
          {
            foreignKeyName: "pharmacy_purchase_order_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "pharmacy_products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pharmacy_purchase_order_items_purchase_order_id_fkey"
            columns: ["purchase_order_id"]
            isOneToOne: false
            referencedRelation: "pharmacy_purchase_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pharmacy_purchase_order_items_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      pharmacy_purchase_orders: {
        Row: {
          created_at: string | null
          created_by: string | null
          email_sent: boolean | null
          email_sent_at: string | null
          expected_date: string | null
          id: string
          notes: string | null
          order_no: string
          status: string
          supplier_id: string
          tenant_id: string
          total_amount: number
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          created_by?: string | null
          email_sent?: boolean | null
          email_sent_at?: string | null
          expected_date?: string | null
          id?: string
          notes?: string | null
          order_no: string
          status?: string
          supplier_id: string
          tenant_id: string
          total_amount: number
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          created_by?: string | null
          email_sent?: boolean | null
          email_sent_at?: string | null
          expected_date?: string | null
          id?: string
          notes?: string | null
          order_no?: string
          status?: string
          supplier_id?: string
          tenant_id?: string
          total_amount?: number
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pharmacy_purchase_orders_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pharmacy_purchase_orders_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "pharmacy_suppliers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pharmacy_purchase_orders_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      pharmacy_settings: {
        Row: {
          contact: string | null
          created_at: string | null
          currency: string
          email: string | null
          footer_text: string | null
          id: string
          location: string | null
          logo: string | null
          low_stock_threshold: number
          pharmacy_name: string
          printer_type: string
          receipt_footer: string | null
          receipt_header: string | null
          tax_rate: number
          tenant_id: string
          updated_at: string | null
        }
        Insert: {
          contact?: string | null
          created_at?: string | null
          currency?: string
          email?: string | null
          footer_text?: string | null
          id?: string
          location?: string | null
          logo?: string | null
          low_stock_threshold?: number
          pharmacy_name?: string
          printer_type?: string
          receipt_footer?: string | null
          receipt_header?: string | null
          tax_rate?: number
          tenant_id: string
          updated_at?: string | null
        }
        Update: {
          contact?: string | null
          created_at?: string | null
          currency?: string
          email?: string | null
          footer_text?: string | null
          id?: string
          location?: string | null
          logo?: string | null
          low_stock_threshold?: number
          pharmacy_name?: string
          printer_type?: string
          receipt_footer?: string | null
          receipt_header?: string | null
          tax_rate?: number
          tenant_id?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pharmacy_settings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      pharmacy_staff_permissions: {
        Row: {
          can_access_credit_records: boolean | null
          can_access_financial_reports: boolean | null
          can_access_settings: boolean | null
          can_apply_discounts: boolean | null
          can_approve_stock_adjustments: boolean | null
          can_edit_inventory: boolean | null
          can_manage_staff: boolean | null
          can_process_sales: boolean | null
          can_view_inventory: boolean | null
          created_at: string | null
          id: string
          max_discount_percent: number | null
          staff_id: string
          tenant_id: string
          updated_at: string | null
        }
        Insert: {
          can_access_credit_records?: boolean | null
          can_access_financial_reports?: boolean | null
          can_access_settings?: boolean | null
          can_apply_discounts?: boolean | null
          can_approve_stock_adjustments?: boolean | null
          can_edit_inventory?: boolean | null
          can_manage_staff?: boolean | null
          can_process_sales?: boolean | null
          can_view_inventory?: boolean | null
          created_at?: string | null
          id?: string
          max_discount_percent?: number | null
          staff_id: string
          tenant_id: string
          updated_at?: string | null
        }
        Update: {
          can_access_credit_records?: boolean | null
          can_access_financial_reports?: boolean | null
          can_access_settings?: boolean | null
          can_apply_discounts?: boolean | null
          can_approve_stock_adjustments?: boolean | null
          can_edit_inventory?: boolean | null
          can_manage_staff?: boolean | null
          can_process_sales?: boolean | null
          can_view_inventory?: boolean | null
          created_at?: string | null
          id?: string
          max_discount_percent?: number | null
          staff_id?: string
          tenant_id?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pharmacy_staff_permissions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      pharmacy_stock_adjustments: {
        Row: {
          created_at: string | null
          created_by: string | null
          id: string
          new_qty: number
          previous_qty: number
          product_id: string
          quantity: number
          reason: string | null
          tenant_id: string
          type: string
        }
        Insert: {
          created_at?: string | null
          created_by?: string | null
          id?: string
          new_qty: number
          previous_qty: number
          product_id: string
          quantity: number
          reason?: string | null
          tenant_id: string
          type: string
        }
        Update: {
          created_at?: string | null
          created_by?: string | null
          id?: string
          new_qty?: number
          previous_qty?: number
          product_id?: string
          quantity?: number
          reason?: string | null
          tenant_id?: string
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "pharmacy_stock_adjustments_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pharmacy_stock_adjustments_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "pharmacy_products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pharmacy_stock_adjustments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      pharmacy_stores: {
        Row: {
          created_at: string
          created_by: string | null
          department_id: string | null
          id: string
          is_active: boolean
          is_deleted: boolean | null
          manager_id: string | null
          name: string
          store_type: string
          tenant_id: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          department_id?: string | null
          id?: string
          is_active?: boolean
          is_deleted?: boolean | null
          manager_id?: string | null
          name: string
          store_type?: string
          tenant_id?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          department_id?: string | null
          id?: string
          is_active?: boolean
          is_deleted?: boolean | null
          manager_id?: string | null
          name?: string
          store_type?: string
          tenant_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pharmacy_stores_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pharmacy_stores_manager_id_fkey"
            columns: ["manager_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pharmacy_stores_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      pharmacy_suppliers: {
        Row: {
          address: string | null
          contact_person: string | null
          created_at: string | null
          email: string | null
          id: string
          is_active: boolean | null
          name: string
          notes: string | null
          phone: string | null
          tenant_id: string
          updated_at: string | null
        }
        Insert: {
          address?: string | null
          contact_person?: string | null
          created_at?: string | null
          email?: string | null
          id?: string
          is_active?: boolean | null
          name: string
          notes?: string | null
          phone?: string | null
          tenant_id: string
          updated_at?: string | null
        }
        Update: {
          address?: string | null
          contact_person?: string | null
          created_at?: string | null
          email?: string | null
          id?: string
          is_active?: boolean | null
          name?: string
          notes?: string | null
          phone?: string | null
          tenant_id?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pharmacy_suppliers_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      pharmacy_transaction_edits: {
        Row: {
          created_at: string | null
          edited_by: string
          id: string
          new_data: Json
          previous_data: Json
          reason: string
          tenant_id: string
          transaction_id: string
        }
        Insert: {
          created_at?: string | null
          edited_by: string
          id?: string
          new_data: Json
          previous_data: Json
          reason: string
          tenant_id: string
          transaction_id: string
        }
        Update: {
          created_at?: string | null
          edited_by?: string
          id?: string
          new_data?: Json
          previous_data?: Json
          reason?: string
          tenant_id?: string
          transaction_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "pharmacy_transaction_edits_edited_by_fkey"
            columns: ["edited_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pharmacy_transaction_edits_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pharmacy_transaction_edits_transaction_id_fkey"
            columns: ["transaction_id"]
            isOneToOne: false
            referencedRelation: "pharmacy_transactions"
            referencedColumns: ["id"]
          },
        ]
      }
      pharmacy_transaction_items: {
        Row: {
          batch_id: string | null
          cost_price: number | null
          created_at: string | null
          id: string
          package_name: string | null
          package_quantity: number | null
          product_id: string
          quantity: number
          tenant_id: string
          total_price: number
          transaction_id: string
          unit_price: number
        }
        Insert: {
          batch_id?: string | null
          cost_price?: number | null
          created_at?: string | null
          id?: string
          package_name?: string | null
          package_quantity?: number | null
          product_id: string
          quantity: number
          tenant_id: string
          total_price: number
          transaction_id: string
          unit_price: number
        }
        Update: {
          batch_id?: string | null
          cost_price?: number | null
          created_at?: string | null
          id?: string
          package_name?: string | null
          package_quantity?: number | null
          product_id?: string
          quantity?: number
          tenant_id?: string
          total_price?: number
          transaction_id?: string
          unit_price?: number
        }
        Relationships: [
          {
            foreignKeyName: "pharmacy_transaction_items_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "pharmacy_product_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pharmacy_transaction_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "pharmacy_products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pharmacy_transaction_items_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pharmacy_transaction_items_transaction_id_fkey"
            columns: ["transaction_id"]
            isOneToOne: false
            referencedRelation: "pharmacy_transactions"
            referencedColumns: ["id"]
          },
        ]
      }
      pharmacy_transactions: {
        Row: {
          cashier_id: string
          client_address: string | null
          client_name: string | null
          client_phone: string | null
          created_at: string | null
          customer_id: string | null
          discount: number
          id: string
          is_edited: boolean | null
          net_amount: number
          notes: string | null
          payment_method: string
          status: string
          tax: number
          tenant_id: string
          total_amount: number
          transaction_no: string
          updated_at: string | null
        }
        Insert: {
          cashier_id: string
          client_address?: string | null
          client_name?: string | null
          client_phone?: string | null
          created_at?: string | null
          customer_id?: string | null
          discount?: number
          id?: string
          is_edited?: boolean | null
          net_amount: number
          notes?: string | null
          payment_method: string
          status?: string
          tax?: number
          tenant_id: string
          total_amount: number
          transaction_no: string
          updated_at?: string | null
        }
        Update: {
          cashier_id?: string
          client_address?: string | null
          client_name?: string | null
          client_phone?: string | null
          created_at?: string | null
          customer_id?: string | null
          discount?: number
          id?: string
          is_edited?: boolean | null
          net_amount?: number
          notes?: string | null
          payment_method?: string
          status?: string
          tax?: number
          tenant_id?: string
          total_amount?: number
          transaction_no?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pharmacy_transactions_cashier_id_fkey"
            columns: ["cashier_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pharmacy_transactions_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "pharmacy_customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pharmacy_transactions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      pharmacy_user_settings: {
        Row: {
          created_at: string | null
          created_by: string | null
          id: string
          is_active: boolean | null
          must_change_password: boolean | null
          permissions: string[] | null
          pharmacy_role: string
          profile_id: string
          tenant_id: string
          two_factor_email: string | null
          two_factor_enabled: boolean | null
          updated_at: string | null
          username: string | null
        }
        Insert: {
          created_at?: string | null
          created_by?: string | null
          id?: string
          is_active?: boolean | null
          must_change_password?: boolean | null
          permissions?: string[] | null
          pharmacy_role?: string
          profile_id: string
          tenant_id: string
          two_factor_email?: string | null
          two_factor_enabled?: boolean | null
          updated_at?: string | null
          username?: string | null
        }
        Update: {
          created_at?: string | null
          created_by?: string | null
          id?: string
          is_active?: boolean | null
          must_change_password?: boolean | null
          permissions?: string[] | null
          pharmacy_role?: string
          profile_id?: string
          tenant_id?: string
          two_factor_email?: string | null
          two_factor_enabled?: boolean | null
          updated_at?: string | null
          username?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pharmacy_user_settings_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pharmacy_user_settings_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pharmacy_user_settings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      phi_access_log: {
        Row: {
          access_type: string
          accessed_at: string
          actor_id: string | null
          actor_role: string | null
          api_endpoint: string | null
          created_at: string | null
          created_by: string | null
          hospital_id: string | null
          id: string
          ip_address: unknown
          is_deleted: boolean | null
          patient_id: string | null
          purpose: string | null
          resource_id: string | null
          resource_type: string
          tenant_id: string | null
          updated_at: string | null
          user_agent: string | null
        }
        Insert: {
          access_type: string
          accessed_at?: string
          actor_id?: string | null
          actor_role?: string | null
          api_endpoint?: string | null
          created_at?: string | null
          created_by?: string | null
          hospital_id?: string | null
          id?: string
          ip_address?: unknown
          is_deleted?: boolean | null
          patient_id?: string | null
          purpose?: string | null
          resource_id?: string | null
          resource_type: string
          tenant_id?: string | null
          updated_at?: string | null
          user_agent?: string | null
        }
        Update: {
          access_type?: string
          accessed_at?: string
          actor_id?: string | null
          actor_role?: string | null
          api_endpoint?: string | null
          created_at?: string | null
          created_by?: string | null
          hospital_id?: string | null
          id?: string
          ip_address?: unknown
          is_deleted?: boolean | null
          patient_id?: string | null
          purpose?: string | null
          resource_id?: string | null
          resource_type?: string
          tenant_id?: string | null
          updated_at?: string | null
          user_agent?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "phi_access_log_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "phi_access_log_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "phi_access_log_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "phi_access_log_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      products: {
        Row: {
          category: string
          created_at: string | null
          created_by: string | null
          description: string | null
          id: string
          image_url: string | null
          is_deleted: boolean | null
          is_gas: boolean | null
          name: string
          price: number
          stock_status: string | null
          tenant_id: string | null
          updated_at: string | null
        }
        Insert: {
          category: string
          created_at?: string | null
          created_by?: string | null
          description?: string | null
          id?: string
          image_url?: string | null
          is_deleted?: boolean | null
          is_gas?: boolean | null
          name: string
          price: number
          stock_status?: string | null
          tenant_id?: string | null
          updated_at?: string | null
        }
        Update: {
          category?: string
          created_at?: string | null
          created_by?: string | null
          description?: string | null
          id?: string
          image_url?: string | null
          is_deleted?: boolean | null
          is_gas?: boolean | null
          name?: string
          price?: number
          stock_status?: string | null
          tenant_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "products_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      professional_leads: {
        Row: {
          bed_count: number | null
          created_at: string
          current_system: string | null
          email: string
          full_name: string
          hear_about_us: string | null
          hospital_name: string | null
          hospital_type: string | null
          id: string
          interests: string[]
          license_number: string | null
          location: string | null
          message: string | null
          phone: string | null
          role: string
          source: string
          specialty: string | null
          status: string
          updated_at: string
        }
        Insert: {
          bed_count?: number | null
          created_at?: string
          current_system?: string | null
          email: string
          full_name: string
          hear_about_us?: string | null
          hospital_name?: string | null
          hospital_type?: string | null
          id?: string
          interests?: string[]
          license_number?: string | null
          location?: string | null
          message?: string | null
          phone?: string | null
          role: string
          source?: string
          specialty?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          bed_count?: number | null
          created_at?: string
          current_system?: string | null
          email?: string
          full_name?: string
          hear_about_us?: string | null
          hospital_name?: string | null
          hospital_type?: string | null
          id?: string
          interests?: string[]
          license_number?: string | null
          location?: string | null
          message?: string | null
          phone?: string | null
          role?: string
          source?: string
          specialty?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          app_user: boolean | null
          avatar_url: string | null
          blood_type: string | null
          created_at: string
          created_by: string | null
          date_of_birth: string | null
          department_id: string | null
          doc_id_card_path: string | null
          doc_medical_license_path: string | null
          email: string | null
          email_override: string | null
          emergency_contact_name: string | null
          emergency_contact_phone: string | null
          first_name: string | null
          full_name: string | null
          gender: string | null
          hospital_id: string | null
          id: string
          is_admin: boolean | null
          is_deleted: boolean | null
          is_verified_student: boolean | null
          last_name: string | null
          last_sign_in_at: string | null
          license_number: string | null
          locked_until: string | null
          login_attempts: number
          must_change_password: boolean
          onboarding_complete: boolean
          password_changed_at: string | null
          password_hash: string | null
          phone: string | null
          rating: number | null
          role: string
          salary_bracket: string | null
          specialty_confirmed: string | null
          synapse_id: string | null
          tenant_id: string | null
          training_hours: number | null
          updated_at: string | null
          verification_status: string
          years_experience: number | null
        }
        Insert: {
          app_user?: boolean | null
          avatar_url?: string | null
          blood_type?: string | null
          created_at?: string
          created_by?: string | null
          date_of_birth?: string | null
          department_id?: string | null
          doc_id_card_path?: string | null
          doc_medical_license_path?: string | null
          email?: string | null
          email_override?: string | null
          emergency_contact_name?: string | null
          emergency_contact_phone?: string | null
          first_name?: string | null
          full_name?: string | null
          gender?: string | null
          hospital_id?: string | null
          id: string
          is_admin?: boolean | null
          is_deleted?: boolean | null
          is_verified_student?: boolean | null
          last_name?: string | null
          last_sign_in_at?: string | null
          license_number?: string | null
          locked_until?: string | null
          login_attempts?: number
          must_change_password?: boolean
          onboarding_complete?: boolean
          password_changed_at?: string | null
          password_hash?: string | null
          phone?: string | null
          rating?: number | null
          role?: string
          salary_bracket?: string | null
          specialty_confirmed?: string | null
          synapse_id?: string | null
          tenant_id?: string | null
          training_hours?: number | null
          updated_at?: string | null
          verification_status?: string
          years_experience?: number | null
        }
        Update: {
          app_user?: boolean | null
          avatar_url?: string | null
          blood_type?: string | null
          created_at?: string
          created_by?: string | null
          date_of_birth?: string | null
          department_id?: string | null
          doc_id_card_path?: string | null
          doc_medical_license_path?: string | null
          email?: string | null
          email_override?: string | null
          emergency_contact_name?: string | null
          emergency_contact_phone?: string | null
          first_name?: string | null
          full_name?: string | null
          gender?: string | null
          hospital_id?: string | null
          id?: string
          is_admin?: boolean | null
          is_deleted?: boolean | null
          is_verified_student?: boolean | null
          last_name?: string | null
          last_sign_in_at?: string | null
          license_number?: string | null
          locked_until?: string | null
          login_attempts?: number
          must_change_password?: boolean
          onboarding_complete?: boolean
          password_changed_at?: string | null
          password_hash?: string | null
          phone?: string | null
          rating?: number | null
          role?: string
          salary_bracket?: string | null
          specialty_confirmed?: string | null
          synapse_id?: string | null
          tenant_id?: string | null
          training_hours?: number | null
          updated_at?: string | null
          verification_status?: string
          years_experience?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "profiles_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profiles_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profiles_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      provider_verification_checks: {
        Row: {
          check_type: string
          checked_at: string | null
          created_at: string
          created_by: string | null
          details: Json
          id: string
          is_deleted: boolean | null
          provider_id: string
          status: string
          tenant_id: string | null
          updated_at: string | null
        }
        Insert: {
          check_type: string
          checked_at?: string | null
          created_at?: string
          created_by?: string | null
          details?: Json
          id?: string
          is_deleted?: boolean | null
          provider_id: string
          status: string
          tenant_id?: string | null
          updated_at?: string | null
        }
        Update: {
          check_type?: string
          checked_at?: string | null
          created_at?: string
          created_by?: string | null
          details?: Json
          id?: string
          is_deleted?: boolean | null
          provider_id?: string
          status?: string
          tenant_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "provider_verification_checks_provider_id_fkey"
            columns: ["provider_id"]
            isOneToOne: false
            referencedRelation: "telemedicine_providers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "provider_verification_checks_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      purchase_orders: {
        Row: {
          created_at: string
          created_by: string | null
          hospital_id: string
          id: string
          is_deleted: boolean | null
          order_date: string
          status: string
          supplier_id: string
          tenant_id: string | null
          total_amount: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          hospital_id: string
          id?: string
          is_deleted?: boolean | null
          order_date?: string
          status?: string
          supplier_id: string
          tenant_id?: string | null
          total_amount?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          hospital_id?: string
          id?: string
          is_deleted?: boolean | null
          order_date?: string
          status?: string
          supplier_id?: string
          tenant_id?: string | null
          total_amount?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "purchase_orders_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_orders_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_orders_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      radiology_report_templates: {
        Row: {
          body_part: string | null
          created_at: string
          created_by: string | null
          hospital_id: string | null
          id: string
          is_active: boolean
          is_deleted: boolean | null
          is_system: boolean
          modality: string
          name: string
          sections: Json
          tenant_id: string | null
          updated_at: string
        }
        Insert: {
          body_part?: string | null
          created_at?: string
          created_by?: string | null
          hospital_id?: string | null
          id?: string
          is_active?: boolean
          is_deleted?: boolean | null
          is_system?: boolean
          modality: string
          name: string
          sections?: Json
          tenant_id?: string | null
          updated_at?: string
        }
        Update: {
          body_part?: string | null
          created_at?: string
          created_by?: string | null
          hospital_id?: string | null
          id?: string
          is_active?: boolean
          is_deleted?: boolean | null
          is_system?: boolean
          modality?: string
          name?: string
          sections?: Json
          tenant_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "radiology_report_templates_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "radiology_report_templates_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "radiology_report_templates_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      radiology_reports: {
        Row: {
          ai_confidence: number | null
          ai_draft_findings: string | null
          ai_draft_impression: string | null
          ai_generated_at: string | null
          ai_model: string | null
          body_part: string | null
          clinical_history: string | null
          created_at: string
          created_by: string | null
          encounter_id: string
          findings: string
          hospital_id: string | null
          id: string
          impression: string | null
          is_critical: boolean
          is_deleted: boolean | null
          modality: string
          radiographer_id: string | null
          radiologist_id: string | null
          recommendation: string | null
          report_pdf_path: string | null
          reported_at: string | null
          status: string
          study_id: string | null
          technique: string | null
          tenant_id: string | null
          updated_at: string
        }
        Insert: {
          ai_confidence?: number | null
          ai_draft_findings?: string | null
          ai_draft_impression?: string | null
          ai_generated_at?: string | null
          ai_model?: string | null
          body_part?: string | null
          clinical_history?: string | null
          created_at?: string
          created_by?: string | null
          encounter_id: string
          findings: string
          hospital_id?: string | null
          id?: string
          impression?: string | null
          is_critical?: boolean
          is_deleted?: boolean | null
          modality: string
          radiographer_id?: string | null
          radiologist_id?: string | null
          recommendation?: string | null
          report_pdf_path?: string | null
          reported_at?: string | null
          status?: string
          study_id?: string | null
          technique?: string | null
          tenant_id?: string | null
          updated_at?: string
        }
        Update: {
          ai_confidence?: number | null
          ai_draft_findings?: string | null
          ai_draft_impression?: string | null
          ai_generated_at?: string | null
          ai_model?: string | null
          body_part?: string | null
          clinical_history?: string | null
          created_at?: string
          created_by?: string | null
          encounter_id?: string
          findings?: string
          hospital_id?: string | null
          id?: string
          impression?: string | null
          is_critical?: boolean
          is_deleted?: boolean | null
          modality?: string
          radiographer_id?: string | null
          radiologist_id?: string | null
          recommendation?: string | null
          report_pdf_path?: string | null
          reported_at?: string | null
          status?: string
          study_id?: string | null
          technique?: string | null
          tenant_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "radiology_reports_encounter_id_fkey"
            columns: ["encounter_id"]
            isOneToOne: false
            referencedRelation: "encounters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "radiology_reports_radiographer_id_fkey"
            columns: ["radiographer_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "radiology_reports_radiologist_id_fkey"
            columns: ["radiologist_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "radiology_reports_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      referral_requests: {
        Row: {
          accepted_by: string | null
          age_years: number | null
          arrived_at: string | null
          bed_id: string | null
          bed_type_requested: string | null
          clinical_summary: string | null
          created_at: string | null
          created_by: string | null
          declined_reason: string | null
          departed_at: string | null
          diagnosis_icd11: string | null
          from_hospital_id: string
          id: string
          is_deleted: boolean | null
          mrn: string | null
          notes: string | null
          patient_id: string | null
          patient_name: string | null
          reason: string
          referred_by: string | null
          reserved_until: string | null
          sex: string | null
          status: string
          tenant_id: string | null
          to_hospital_id: string | null
          transport_arranged: boolean | null
          transport_type: string | null
          updated_at: string | null
          urgency: string
        }
        Insert: {
          accepted_by?: string | null
          age_years?: number | null
          arrived_at?: string | null
          bed_id?: string | null
          bed_type_requested?: string | null
          clinical_summary?: string | null
          created_at?: string | null
          created_by?: string | null
          declined_reason?: string | null
          departed_at?: string | null
          diagnosis_icd11?: string | null
          from_hospital_id: string
          id?: string
          is_deleted?: boolean | null
          mrn?: string | null
          notes?: string | null
          patient_id?: string | null
          patient_name?: string | null
          reason: string
          referred_by?: string | null
          reserved_until?: string | null
          sex?: string | null
          status?: string
          tenant_id?: string | null
          to_hospital_id?: string | null
          transport_arranged?: boolean | null
          transport_type?: string | null
          updated_at?: string | null
          urgency?: string
        }
        Update: {
          accepted_by?: string | null
          age_years?: number | null
          arrived_at?: string | null
          bed_id?: string | null
          bed_type_requested?: string | null
          clinical_summary?: string | null
          created_at?: string | null
          created_by?: string | null
          declined_reason?: string | null
          departed_at?: string | null
          diagnosis_icd11?: string | null
          from_hospital_id?: string
          id?: string
          is_deleted?: boolean | null
          mrn?: string | null
          notes?: string | null
          patient_id?: string | null
          patient_name?: string | null
          reason?: string
          referred_by?: string | null
          reserved_until?: string | null
          sex?: string | null
          status?: string
          tenant_id?: string | null
          to_hospital_id?: string | null
          transport_arranged?: boolean | null
          transport_type?: string | null
          updated_at?: string | null
          urgency?: string
        }
        Relationships: [
          {
            foreignKeyName: "referral_requests_accepted_by_fkey"
            columns: ["accepted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "referral_requests_bed_id_fkey"
            columns: ["bed_id"]
            isOneToOne: false
            referencedRelation: "hospital_beds"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "referral_requests_from_hospital_id_fkey"
            columns: ["from_hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "referral_requests_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "referral_requests_referred_by_fkey"
            columns: ["referred_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "referral_requests_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "referral_requests_to_hospital_id_fkey"
            columns: ["to_hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
        ]
      }
      refill_reminders: {
        Row: {
          created_at: string | null
          customer_id: string | null
          dispensed: boolean | null
          dispensed_at: string | null
          drug_name: string
          id: string
          interval_days: number | null
          last_dispensed: string | null
          last_reminder_sent_at: string | null
          refill_due_date: string
          reminder_sent: boolean | null
          tenant_id: string
        }
        Insert: {
          created_at?: string | null
          customer_id?: string | null
          dispensed?: boolean | null
          dispensed_at?: string | null
          drug_name: string
          id?: string
          interval_days?: number | null
          last_dispensed?: string | null
          last_reminder_sent_at?: string | null
          refill_due_date: string
          reminder_sent?: boolean | null
          tenant_id: string
        }
        Update: {
          created_at?: string | null
          customer_id?: string | null
          dispensed?: boolean | null
          dispensed_at?: string | null
          drug_name?: string
          id?: string
          interval_days?: number | null
          last_dispensed?: string | null
          last_reminder_sent_at?: string | null
          refill_due_date?: string
          reminder_sent?: boolean | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "refill_reminders_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "pharmacy_customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "refill_reminders_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      renal_adjustments_catalog: {
        Row: {
          created_at: string
          created_by: string | null
          creatinine_clearance_max: number
          creatinine_clearance_min: number
          dose_adjustment: number
          drug_atc: string
          frequency_adjustment: string | null
          id: string
          is_deleted: boolean | null
          recommendation: string
          tenant_id: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          creatinine_clearance_max: number
          creatinine_clearance_min: number
          dose_adjustment: number
          drug_atc: string
          frequency_adjustment?: string | null
          id?: string
          is_deleted?: boolean | null
          recommendation: string
          tenant_id?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          creatinine_clearance_max?: number
          creatinine_clearance_min?: number
          dose_adjustment?: number
          drug_atc?: string
          frequency_adjustment?: string | null
          id?: string
          is_deleted?: boolean | null
          recommendation?: string
          tenant_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "renal_adjustments_catalog_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      restaurants: {
        Row: {
          created_at: string | null
          created_by: string | null
          delivery_time: string | null
          id: string
          image_url: string | null
          is_deleted: boolean | null
          name: string
          rating: number | null
          tenant_id: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          created_by?: string | null
          delivery_time?: string | null
          id?: string
          image_url?: string | null
          is_deleted?: boolean | null
          name: string
          rating?: number | null
          tenant_id?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          created_by?: string | null
          delivery_time?: string | null
          id?: string
          image_url?: string | null
          is_deleted?: boolean | null
          name?: string
          rating?: number | null
          tenant_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "restaurants_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      rule_executions: {
        Row: {
          created_at: string | null
          created_by: string | null
          encounter_id: string | null
          executed_at: string
          id: string
          input_data: Json
          is_deleted: boolean | null
          metadata: Json
          output: Json
          overridden_by: string | null
          override_reason: string | null
          patient_id: string | null
          rule_id: string
          tenant_id: string | null
          triggered_at: string
          updated_at: string | null
          was_blocked: boolean
        }
        Insert: {
          created_at?: string | null
          created_by?: string | null
          encounter_id?: string | null
          executed_at?: string
          id?: string
          input_data: Json
          is_deleted?: boolean | null
          metadata?: Json
          output: Json
          overridden_by?: string | null
          override_reason?: string | null
          patient_id?: string | null
          rule_id: string
          tenant_id?: string | null
          triggered_at?: string
          updated_at?: string | null
          was_blocked?: boolean
        }
        Update: {
          created_at?: string | null
          created_by?: string | null
          encounter_id?: string | null
          executed_at?: string
          id?: string
          input_data?: Json
          is_deleted?: boolean | null
          metadata?: Json
          output?: Json
          overridden_by?: string | null
          override_reason?: string | null
          patient_id?: string | null
          rule_id?: string
          tenant_id?: string | null
          triggered_at?: string
          updated_at?: string | null
          was_blocked?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "rule_executions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      scan_events: {
        Row: {
          barcode: string
          barcode_format: string
          created_at: string | null
          created_by: string | null
          detail: Json
          device_id: string | null
          hospital_id: string | null
          id: string
          is_deleted: boolean | null
          outcome: string
          patient_id: string | null
          resolved_entity: string | null
          resolved_id: string | null
          scan_type: string
          scanned_at: string
          scanned_by: string | null
          tenant_id: string | null
          updated_at: string | null
        }
        Insert: {
          barcode: string
          barcode_format?: string
          created_at?: string | null
          created_by?: string | null
          detail?: Json
          device_id?: string | null
          hospital_id?: string | null
          id?: string
          is_deleted?: boolean | null
          outcome?: string
          patient_id?: string | null
          resolved_entity?: string | null
          resolved_id?: string | null
          scan_type: string
          scanned_at?: string
          scanned_by?: string | null
          tenant_id?: string | null
          updated_at?: string | null
        }
        Update: {
          barcode?: string
          barcode_format?: string
          created_at?: string | null
          created_by?: string | null
          detail?: Json
          device_id?: string | null
          hospital_id?: string | null
          id?: string
          is_deleted?: boolean | null
          outcome?: string
          patient_id?: string | null
          resolved_entity?: string | null
          resolved_id?: string | null
          scan_type?: string
          scanned_at?: string
          scanned_by?: string | null
          tenant_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "scan_events_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "medical_devices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scan_events_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scan_events_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scan_events_scanned_by_fkey"
            columns: ["scanned_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scan_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      sdg_indicators: {
        Row: {
          created_at: string
          goal_number: number
          hospital_id: string | null
          id: string
          indicator_key: string
          metadata: Json | null
          recorded_at: string
          unit: string | null
          value: number
        }
        Insert: {
          created_at?: string
          goal_number: number
          hospital_id?: string | null
          id?: string
          indicator_key: string
          metadata?: Json | null
          recorded_at?: string
          unit?: string | null
          value: number
        }
        Update: {
          created_at?: string
          goal_number?: number
          hospital_id?: string | null
          id?: string
          indicator_key?: string
          metadata?: Json | null
          recorded_at?: string
          unit?: string | null
          value?: number
        }
        Relationships: [
          {
            foreignKeyName: "sdg_indicators_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
        ]
      }
      sdg_reports: {
        Row: {
          created_at: string
          format: string
          generated_by: string | null
          hospital_id: string | null
          id: string
          metadata: Json | null
          report_type: string
          storage_path: string | null
        }
        Insert: {
          created_at?: string
          format?: string
          generated_by?: string | null
          hospital_id?: string | null
          id?: string
          metadata?: Json | null
          report_type: string
          storage_path?: string | null
        }
        Update: {
          created_at?: string
          format?: string
          generated_by?: string | null
          hospital_id?: string | null
          id?: string
          metadata?: Json | null
          report_type?: string
          storage_path?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sdg_reports_generated_by_fkey"
            columns: ["generated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sdg_reports_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
        ]
      }
      sentinel_alerts: {
        Row: {
          acknowledged_at: string | null
          acknowledged_by: string | null
          alert_type: string
          created_at: string | null
          created_by: string | null
          details: Json | null
          hospital_id: string
          icd11_codes: string[] | null
          id: string
          is_deleted: boolean | null
          severity: string | null
          status: string | null
          tenant_id: string | null
          trigger_count: number
          updated_at: string | null
          window_hours: number
        }
        Insert: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          alert_type: string
          created_at?: string | null
          created_by?: string | null
          details?: Json | null
          hospital_id: string
          icd11_codes?: string[] | null
          id?: string
          is_deleted?: boolean | null
          severity?: string | null
          status?: string | null
          tenant_id?: string | null
          trigger_count: number
          updated_at?: string | null
          window_hours: number
        }
        Update: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          alert_type?: string
          created_at?: string | null
          created_by?: string | null
          details?: Json | null
          hospital_id?: string
          icd11_codes?: string[] | null
          id?: string
          is_deleted?: boolean | null
          severity?: string | null
          status?: string | null
          tenant_id?: string | null
          trigger_count?: number
          updated_at?: string | null
          window_hours?: number
        }
        Relationships: [
          {
            foreignKeyName: "sentinel_alerts_acknowledged_by_fkey"
            columns: ["acknowledged_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sentinel_alerts_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sentinel_alerts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      service_catalog: {
        Row: {
          created_at: string
          created_by: string | null
          currency: string
          id: string
          is_active: boolean
          is_deleted: boolean | null
          name: string
          price: number
          service_type: string
          tenant_id: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          currency?: string
          id?: string
          is_active?: boolean
          is_deleted?: boolean | null
          name: string
          price?: number
          service_type?: string
          tenant_id?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          currency?: string
          id?: string
          is_active?: boolean
          is_deleted?: boolean | null
          name?: string
          price?: number
          service_type?: string
          tenant_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "service_catalog_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_attendance: {
        Row: {
          check_in: string
          check_out: string | null
          created_at: string
          created_by: string | null
          hospital_id: string
          id: string
          is_deleted: boolean | null
          profile_id: string
          status: string
          tenant_id: string | null
          updated_at: string | null
        }
        Insert: {
          check_in?: string
          check_out?: string | null
          created_at?: string
          created_by?: string | null
          hospital_id: string
          id?: string
          is_deleted?: boolean | null
          profile_id: string
          status?: string
          tenant_id?: string | null
          updated_at?: string | null
        }
        Update: {
          check_in?: string
          check_out?: string | null
          created_at?: string
          created_by?: string | null
          hospital_id?: string
          id?: string
          is_deleted?: boolean | null
          profile_id?: string
          status?: string
          tenant_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "staff_attendance_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_attendance_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_attendance_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_leave_requests: {
        Row: {
          approved_by: string | null
          created_at: string
          created_by: string | null
          end_date: string
          id: string
          is_deleted: boolean | null
          leave_type: string
          profile_id: string
          reason: string | null
          start_date: string
          status: string
          tenant_id: string | null
          updated_at: string | null
        }
        Insert: {
          approved_by?: string | null
          created_at?: string
          created_by?: string | null
          end_date: string
          id?: string
          is_deleted?: boolean | null
          leave_type: string
          profile_id: string
          reason?: string | null
          start_date: string
          status?: string
          tenant_id?: string | null
          updated_at?: string | null
        }
        Update: {
          approved_by?: string | null
          created_at?: string
          created_by?: string | null
          end_date?: string
          id?: string
          is_deleted?: boolean | null
          leave_type?: string
          profile_id?: string
          reason?: string | null
          start_date?: string
          status?: string
          tenant_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "staff_leave_requests_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_leave_requests_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_leave_requests_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      suppliers: {
        Row: {
          category: string | null
          contact_person: string | null
          created_at: string
          created_by: string | null
          email: string | null
          id: string
          is_active: boolean
          is_deleted: boolean | null
          name: string
          phone: string | null
          tenant_id: string | null
          updated_at: string | null
        }
        Insert: {
          category?: string | null
          contact_person?: string | null
          created_at?: string
          created_by?: string | null
          email?: string | null
          id?: string
          is_active?: boolean
          is_deleted?: boolean | null
          name: string
          phone?: string | null
          tenant_id?: string | null
          updated_at?: string | null
        }
        Update: {
          category?: string | null
          contact_person?: string | null
          created_at?: string
          created_by?: string | null
          email?: string | null
          id?: string
          is_active?: boolean
          is_deleted?: boolean | null
          name?: string
          phone?: string | null
          tenant_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "suppliers_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      surgery_schedules: {
        Row: {
          actual_end: string | null
          actual_start: string | null
          anesthesiologist_id: string | null
          checklist_completed: boolean
          created_at: string
          created_by: string | null
          hospital_id: string
          id: string
          implants_used: string | null
          instrument_count_post: Json | null
          instrument_count_pre: Json | null
          intraop_complications: string | null
          is_deleted: boolean | null
          patient_id: string
          post_op_notes: string | null
          pre_op_checklist: Json | null
          procedure_name: string
          scheduled_at: string
          status: string
          surgeon_id: string | null
          tenant_id: string | null
          updated_at: string
        }
        Insert: {
          actual_end?: string | null
          actual_start?: string | null
          anesthesiologist_id?: string | null
          checklist_completed?: boolean
          created_at?: string
          created_by?: string | null
          hospital_id: string
          id?: string
          implants_used?: string | null
          instrument_count_post?: Json | null
          instrument_count_pre?: Json | null
          intraop_complications?: string | null
          is_deleted?: boolean | null
          patient_id: string
          post_op_notes?: string | null
          pre_op_checklist?: Json | null
          procedure_name: string
          scheduled_at: string
          status?: string
          surgeon_id?: string | null
          tenant_id?: string | null
          updated_at?: string
        }
        Update: {
          actual_end?: string | null
          actual_start?: string | null
          anesthesiologist_id?: string | null
          checklist_completed?: boolean
          created_at?: string
          created_by?: string | null
          hospital_id?: string
          id?: string
          implants_used?: string | null
          instrument_count_post?: Json | null
          instrument_count_pre?: Json | null
          intraop_complications?: string | null
          is_deleted?: boolean | null
          patient_id?: string
          post_op_notes?: string | null
          pre_op_checklist?: Json | null
          procedure_name?: string
          scheduled_at?: string
          status?: string
          surgeon_id?: string | null
          tenant_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "surgery_schedules_anesthesiologist_id_fkey"
            columns: ["anesthesiologist_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "surgery_schedules_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "surgery_schedules_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "surgery_schedules_surgeon_id_fkey"
            columns: ["surgeon_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "surgery_schedules_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      surveillance_reports: {
        Row: {
          created_at: string | null
          district: string | null
          duration: string | null
          household_affected: boolean | null
          id: string
          is_anonymous: boolean | null
          lat: number | null
          lng: number | null
          recent_travel: boolean | null
          report_ref: string | null
          reviewed: boolean | null
          severity: string | null
          symptoms: string[]
          tenant_id: string | null
          travel_location: string | null
        }
        Insert: {
          created_at?: string | null
          district?: string | null
          duration?: string | null
          household_affected?: boolean | null
          id?: string
          is_anonymous?: boolean | null
          lat?: number | null
          lng?: number | null
          recent_travel?: boolean | null
          report_ref?: string | null
          reviewed?: boolean | null
          severity?: string | null
          symptoms: string[]
          tenant_id?: string | null
          travel_location?: string | null
        }
        Update: {
          created_at?: string | null
          district?: string | null
          duration?: string | null
          household_affected?: boolean | null
          id?: string
          is_anonymous?: boolean | null
          lat?: number | null
          lng?: number | null
          recent_travel?: boolean | null
          report_ref?: string | null
          reviewed?: boolean | null
          severity?: string | null
          symptoms?: string[]
          tenant_id?: string | null
          travel_location?: string | null
        }
        Relationships: []
      }
      synapse_domain_events: {
        Row: {
          actor_id: string | null
          causation_id: string | null
          correlation_id: string
          created_at: string
          encounter_id: string | null
          event_id: string
          event_type: string
          facility_id: string | null
          idempotency_key: string
          is_synthetic: boolean
          last_error: string | null
          locked_until: string | null
          next_attempt_at: string | null
          occurred_at: string
          patient_id: string | null
          payload: Json
          person_id: string | null
          published_at: string | null
          retry_count: number
          simulation_run_id: string | null
          source: string
          status: string
          tenant_id: string
          version: string
        }
        Insert: {
          actor_id?: string | null
          causation_id?: string | null
          correlation_id: string
          created_at?: string
          encounter_id?: string | null
          event_id?: string
          event_type: string
          facility_id?: string | null
          idempotency_key: string
          is_synthetic?: boolean
          last_error?: string | null
          locked_until?: string | null
          next_attempt_at?: string | null
          occurred_at?: string
          patient_id?: string | null
          payload?: Json
          person_id?: string | null
          published_at?: string | null
          retry_count?: number
          simulation_run_id?: string | null
          source: string
          status?: string
          tenant_id: string
          version?: string
        }
        Update: {
          actor_id?: string | null
          causation_id?: string | null
          correlation_id?: string
          created_at?: string
          encounter_id?: string | null
          event_id?: string
          event_type?: string
          facility_id?: string | null
          idempotency_key?: string
          is_synthetic?: boolean
          last_error?: string | null
          locked_until?: string | null
          next_attempt_at?: string | null
          occurred_at?: string
          patient_id?: string | null
          payload?: Json
          person_id?: string | null
          published_at?: string | null
          retry_count?: number
          simulation_run_id?: string | null
          source?: string
          status?: string
          tenant_id?: string
          version?: string
        }
        Relationships: [
          {
            foreignKeyName: "synapse_domain_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      synapse_sessions: {
        Row: {
          app: string
          created_at: string | null
          expires_at: string
          id: string
          ip_address: string | null
          last_used_at: string | null
          revoked_at: string | null
          token_hash: string
          user_agent: string | null
          user_id: string
        }
        Insert: {
          app: string
          created_at?: string | null
          expires_at: string
          id?: string
          ip_address?: string | null
          last_used_at?: string | null
          revoked_at?: string | null
          token_hash: string
          user_agent?: string | null
          user_id: string
        }
        Update: {
          app?: string
          created_at?: string | null
          expires_at?: string
          id?: string
          ip_address?: string | null
          last_used_at?: string | null
          revoked_at?: string | null
          token_hash?: string
          user_agent?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "synapse_sessions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      sync_conflicts: {
        Row: {
          auto_resolved: boolean | null
          client_data: Json
          client_device_id: string | null
          client_synced_at: string | null
          client_version: number
          created_at: string | null
          created_by: string | null
          hospital_id: string | null
          id: string
          is_deleted: boolean | null
          record_id: string
          resolution_strategy: string | null
          resolved_at: string | null
          resolved_by: string | null
          resolved_data: Json | null
          server_data: Json
          server_version: number
          status: string
          table_name: string
          tenant_id: string | null
          updated_at: string | null
        }
        Insert: {
          auto_resolved?: boolean | null
          client_data: Json
          client_device_id?: string | null
          client_synced_at?: string | null
          client_version: number
          created_at?: string | null
          created_by?: string | null
          hospital_id?: string | null
          id?: string
          is_deleted?: boolean | null
          record_id: string
          resolution_strategy?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          resolved_data?: Json | null
          server_data: Json
          server_version: number
          status?: string
          table_name: string
          tenant_id?: string | null
          updated_at?: string | null
        }
        Update: {
          auto_resolved?: boolean | null
          client_data?: Json
          client_device_id?: string | null
          client_synced_at?: string | null
          client_version?: number
          created_at?: string | null
          created_by?: string | null
          hospital_id?: string | null
          id?: string
          is_deleted?: boolean | null
          record_id?: string
          resolution_strategy?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          resolved_data?: Json | null
          server_data?: Json
          server_version?: number
          status?: string
          table_name?: string
          tenant_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sync_conflicts_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sync_conflicts_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sync_conflicts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      sync_idempotency_keys: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          idempotency_key: string
          is_deleted: boolean | null
          response_payload: Json
          scope: string
          tenant_id: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          idempotency_key: string
          is_deleted?: boolean | null
          response_payload: Json
          scope: string
          tenant_id?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          idempotency_key?: string
          is_deleted?: boolean | null
          response_payload?: Json
          scope?: string
          tenant_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sync_idempotency_keys_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      telemedicine_appointments: {
        Row: {
          channel: string
          chief_complaint: string | null
          created_at: string
          created_by: string | null
          ended_at: string | null
          hospital_id: string
          id: string
          is_deleted: boolean | null
          meeting_room: string | null
          meeting_url: string | null
          notes: string | null
          patient_id: string | null
          provider_id: string
          scheduled_for: string
          started_at: string | null
          status: string
          tenant_id: string | null
          triage_summary: Json
          updated_at: string
        }
        Insert: {
          channel?: string
          chief_complaint?: string | null
          created_at?: string
          created_by?: string | null
          ended_at?: string | null
          hospital_id: string
          id?: string
          is_deleted?: boolean | null
          meeting_room?: string | null
          meeting_url?: string | null
          notes?: string | null
          patient_id?: string | null
          provider_id: string
          scheduled_for: string
          started_at?: string | null
          status?: string
          tenant_id?: string | null
          triage_summary?: Json
          updated_at?: string
        }
        Update: {
          channel?: string
          chief_complaint?: string | null
          created_at?: string
          created_by?: string | null
          ended_at?: string | null
          hospital_id?: string
          id?: string
          is_deleted?: boolean | null
          meeting_room?: string | null
          meeting_url?: string | null
          notes?: string | null
          patient_id?: string | null
          provider_id?: string
          scheduled_for?: string
          started_at?: string | null
          status?: string
          tenant_id?: string | null
          triage_summary?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "telemedicine_appointments_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telemedicine_appointments_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telemedicine_appointments_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telemedicine_appointments_provider_id_fkey"
            columns: ["provider_id"]
            isOneToOne: false
            referencedRelation: "telemedicine_providers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telemedicine_appointments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      telemedicine_followups: {
        Row: {
          attempts: number
          case_id: string
          created_at: string
          created_by: string | null
          due_at: string
          followup_type: string
          hospital_id: string | null
          id: string
          is_deleted: boolean | null
          last_error: string | null
          max_attempts: number
          payload: Json
          sent_at: string | null
          status: string
          tenant_id: string | null
          updated_at: string
        }
        Insert: {
          attempts?: number
          case_id: string
          created_at?: string
          created_by?: string | null
          due_at: string
          followup_type?: string
          hospital_id?: string | null
          id?: string
          is_deleted?: boolean | null
          last_error?: string | null
          max_attempts?: number
          payload?: Json
          sent_at?: string | null
          status?: string
          tenant_id?: string | null
          updated_at?: string
        }
        Update: {
          attempts?: number
          case_id?: string
          created_at?: string
          created_by?: string | null
          due_at?: string
          followup_type?: string
          hospital_id?: string | null
          id?: string
          is_deleted?: boolean | null
          last_error?: string | null
          max_attempts?: number
          payload?: Json
          sent_at?: string | null
          status?: string
          tenant_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "telemedicine_followups_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "telemedicine_intake_cases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telemedicine_followups_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telemedicine_followups_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      telemedicine_frontdesk_queue: {
        Row: {
          captured_payload: Json
          case_id: string
          completed_at: string | null
          completed_by: string | null
          created_at: string
          created_by: string | null
          hospital_id: string | null
          id: string
          is_deleted: boolean | null
          missing_fields: Json
          notes: string | null
          patient_id: string | null
          provider_id: string | null
          status: string
          tenant_id: string | null
          updated_at: string
        }
        Insert: {
          captured_payload?: Json
          case_id: string
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          created_by?: string | null
          hospital_id?: string | null
          id?: string
          is_deleted?: boolean | null
          missing_fields?: Json
          notes?: string | null
          patient_id?: string | null
          provider_id?: string | null
          status?: string
          tenant_id?: string | null
          updated_at?: string
        }
        Update: {
          captured_payload?: Json
          case_id?: string
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          created_by?: string | null
          hospital_id?: string | null
          id?: string
          is_deleted?: boolean | null
          missing_fields?: Json
          notes?: string | null
          patient_id?: string | null
          provider_id?: string | null
          status?: string
          tenant_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "telemedicine_frontdesk_queue_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: true
            referencedRelation: "telemedicine_intake_cases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telemedicine_frontdesk_queue_completed_by_fkey"
            columns: ["completed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telemedicine_frontdesk_queue_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telemedicine_frontdesk_queue_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telemedicine_frontdesk_queue_provider_id_fkey"
            columns: ["provider_id"]
            isOneToOne: false
            referencedRelation: "telemedicine_providers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telemedicine_frontdesk_queue_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      telemedicine_intake_cases: {
        Row: {
          consent_to_register: boolean
          created_at: string
          created_by: string | null
          hospital_id: string | null
          id: string
          is_deleted: boolean | null
          location_text: string | null
          patient_id: string | null
          provider_id: string | null
          recommendation: Json
          status: string
          symptoms: string | null
          tenant_id: string | null
          triage_summary: Json
          updated_at: string
          urgency: string
          user_id: string | null
        }
        Insert: {
          consent_to_register?: boolean
          created_at?: string
          created_by?: string | null
          hospital_id?: string | null
          id?: string
          is_deleted?: boolean | null
          location_text?: string | null
          patient_id?: string | null
          provider_id?: string | null
          recommendation?: Json
          status?: string
          symptoms?: string | null
          tenant_id?: string | null
          triage_summary?: Json
          updated_at?: string
          urgency?: string
          user_id?: string | null
        }
        Update: {
          consent_to_register?: boolean
          created_at?: string
          created_by?: string | null
          hospital_id?: string | null
          id?: string
          is_deleted?: boolean | null
          location_text?: string | null
          patient_id?: string | null
          provider_id?: string | null
          recommendation?: Json
          status?: string
          symptoms?: string | null
          tenant_id?: string | null
          triage_summary?: Json
          updated_at?: string
          urgency?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "telemedicine_intake_cases_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telemedicine_intake_cases_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telemedicine_intake_cases_provider_id_fkey"
            columns: ["provider_id"]
            isOneToOne: false
            referencedRelation: "telemedicine_providers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telemedicine_intake_cases_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      telemedicine_intake_messages: {
        Row: {
          case_id: string
          content: string
          created_at: string
          created_by: string | null
          id: string
          is_deleted: boolean | null
          metadata: Json
          role: string
          tenant_id: string | null
          updated_at: string | null
        }
        Insert: {
          case_id: string
          content: string
          created_at?: string
          created_by?: string | null
          id?: string
          is_deleted?: boolean | null
          metadata?: Json
          role: string
          tenant_id?: string | null
          updated_at?: string | null
        }
        Update: {
          case_id?: string
          content?: string
          created_at?: string
          created_by?: string | null
          id?: string
          is_deleted?: boolean | null
          metadata?: Json
          role?: string
          tenant_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "telemedicine_intake_messages_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "telemedicine_intake_cases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telemedicine_intake_messages_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      telemedicine_providers: {
        Row: {
          bio: string | null
          consultation_types: string[]
          council: string | null
          country_code: string | null
          created_at: string
          created_by: string | null
          full_name: string
          hospital_id: string | null
          id: string
          is_active: boolean
          is_available: boolean
          is_deleted: boolean | null
          languages: string[]
          last_seen_at: string | null
          license_number: string | null
          profile_id: string | null
          rating: number | null
          rejection_reason: string | null
          specialty: string
          tenant_id: string | null
          updated_at: string
          verification_metadata: Json
          verification_method: string
          verification_status: string
          verified_at: string | null
          verified_by: string | null
          years_experience: number | null
        }
        Insert: {
          bio?: string | null
          consultation_types?: string[]
          council?: string | null
          country_code?: string | null
          created_at?: string
          created_by?: string | null
          full_name: string
          hospital_id?: string | null
          id?: string
          is_active?: boolean
          is_available?: boolean
          is_deleted?: boolean | null
          languages?: string[]
          last_seen_at?: string | null
          license_number?: string | null
          profile_id?: string | null
          rating?: number | null
          rejection_reason?: string | null
          specialty: string
          tenant_id?: string | null
          updated_at?: string
          verification_metadata?: Json
          verification_method?: string
          verification_status?: string
          verified_at?: string | null
          verified_by?: string | null
          years_experience?: number | null
        }
        Update: {
          bio?: string | null
          consultation_types?: string[]
          council?: string | null
          country_code?: string | null
          created_at?: string
          created_by?: string | null
          full_name?: string
          hospital_id?: string | null
          id?: string
          is_active?: boolean
          is_available?: boolean
          is_deleted?: boolean | null
          languages?: string[]
          last_seen_at?: string | null
          license_number?: string | null
          profile_id?: string | null
          rating?: number | null
          rejection_reason?: string | null
          specialty?: string
          tenant_id?: string | null
          updated_at?: string
          verification_metadata?: Json
          verification_method?: string
          verification_status?: string
          verified_at?: string | null
          verified_by?: string | null
          years_experience?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "telemedicine_providers_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telemedicine_providers_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telemedicine_providers_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telemedicine_providers_verified_by_fkey"
            columns: ["verified_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      telemedicine_session_events: {
        Row: {
          actor_id: string | null
          appointment_id: string
          created_at: string
          created_by: string | null
          event_type: string
          id: string
          is_deleted: boolean | null
          payload: Json
          tenant_id: string | null
          updated_at: string | null
        }
        Insert: {
          actor_id?: string | null
          appointment_id: string
          created_at?: string
          created_by?: string | null
          event_type: string
          id?: string
          is_deleted?: boolean | null
          payload?: Json
          tenant_id?: string | null
          updated_at?: string | null
        }
        Update: {
          actor_id?: string | null
          appointment_id?: string
          created_at?: string
          created_by?: string | null
          event_type?: string
          id?: string
          is_deleted?: boolean | null
          payload?: Json
          tenant_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "telemedicine_session_events_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telemedicine_session_events_appointment_id_fkey"
            columns: ["appointment_id"]
            isOneToOne: false
            referencedRelation: "telemedicine_appointments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telemedicine_session_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      telemedicine_staff_alerts: {
        Row: {
          acknowledged_at: string | null
          acknowledged_by: string | null
          case_id: string
          created_at: string
          created_by: string | null
          department: string
          hospital_id: string | null
          id: string
          is_deleted: boolean | null
          patient_id: string | null
          payload: Json
          priority: string
          sbar: Json
          status: string
          summary: string
          tenant_id: string | null
          updated_at: string
        }
        Insert: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          case_id: string
          created_at?: string
          created_by?: string | null
          department: string
          hospital_id?: string | null
          id?: string
          is_deleted?: boolean | null
          patient_id?: string | null
          payload?: Json
          priority?: string
          sbar?: Json
          status?: string
          summary: string
          tenant_id?: string | null
          updated_at?: string
        }
        Update: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          case_id?: string
          created_at?: string
          created_by?: string | null
          department?: string
          hospital_id?: string | null
          id?: string
          is_deleted?: boolean | null
          patient_id?: string | null
          payload?: Json
          priority?: string
          sbar?: Json
          status?: string
          summary?: string
          tenant_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "telemedicine_staff_alerts_acknowledged_by_fkey"
            columns: ["acknowledged_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telemedicine_staff_alerts_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "telemedicine_intake_cases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telemedicine_staff_alerts_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telemedicine_staff_alerts_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telemedicine_staff_alerts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      telemedicine_voice_memos: {
        Row: {
          audio_base64: string | null
          case_id: string
          created_at: string
          created_by: string | null
          duration_seconds: number | null
          id: string
          is_deleted: boolean | null
          language: string | null
          metadata: Json
          mime_type: string | null
          tenant_id: string | null
          transcript_en: string | null
          transcript_original: string | null
          translation_engine: string | null
          updated_at: string | null
          uploaded_by: string | null
        }
        Insert: {
          audio_base64?: string | null
          case_id: string
          created_at?: string
          created_by?: string | null
          duration_seconds?: number | null
          id?: string
          is_deleted?: boolean | null
          language?: string | null
          metadata?: Json
          mime_type?: string | null
          tenant_id?: string | null
          transcript_en?: string | null
          transcript_original?: string | null
          translation_engine?: string | null
          updated_at?: string | null
          uploaded_by?: string | null
        }
        Update: {
          audio_base64?: string | null
          case_id?: string
          created_at?: string
          created_by?: string | null
          duration_seconds?: number | null
          id?: string
          is_deleted?: boolean | null
          language?: string | null
          metadata?: Json
          mime_type?: string | null
          tenant_id?: string | null
          transcript_en?: string | null
          transcript_original?: string | null
          translation_engine?: string | null
          updated_at?: string | null
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "telemedicine_voice_memos_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "telemedicine_intake_cases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telemedicine_voice_memos_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telemedicine_voice_memos_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_domains: {
        Row: {
          created_at: string
          created_by: string | null
          dns_target: string | null
          domain: string
          hospital_id: string
          id: string
          is_active: boolean
          is_deleted: boolean | null
          is_primary: boolean
          last_error: string | null
          metadata: Json
          provisioned_at: string | null
          provisioning_status: string
          tenant_id: string | null
          tenant_key: string
          updated_at: string
          verification_token: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          dns_target?: string | null
          domain: string
          hospital_id: string
          id?: string
          is_active?: boolean
          is_deleted?: boolean | null
          is_primary?: boolean
          last_error?: string | null
          metadata?: Json
          provisioned_at?: string | null
          provisioning_status?: string
          tenant_id?: string | null
          tenant_key: string
          updated_at?: string
          verification_token?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          dns_target?: string | null
          domain?: string
          hospital_id?: string
          id?: string
          is_active?: boolean
          is_deleted?: boolean | null
          is_primary?: boolean
          last_error?: string | null
          metadata?: Json
          provisioned_at?: string | null
          provisioning_status?: string
          tenant_id?: string | null
          tenant_key?: string
          updated_at?: string
          verification_token?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tenant_domains_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_domains_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_logging_policies: {
        Row: {
          created_at: string
          created_by: string | null
          enabled_events: Json
          hospital_id: string | null
          id: string
          is_deleted: boolean | null
          min_level: string
          module_name: string
          pii_strategy: string
          retention_days: number
          sampling_rate: number
          tenant_id: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          enabled_events?: Json
          hospital_id?: string | null
          id?: string
          is_deleted?: boolean | null
          min_level?: string
          module_name: string
          pii_strategy?: string
          retention_days?: number
          sampling_rate?: number
          tenant_id?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          enabled_events?: Json
          hospital_id?: string | null
          id?: string
          is_deleted?: boolean | null
          min_level?: string
          module_name?: string
          pii_strategy?: string
          retention_days?: number
          sampling_rate?: number
          tenant_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_logging_policies_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_logging_policies_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_provisioning_jobs: {
        Row: {
          attempt_count: number
          completed_at: string | null
          created_at: string
          created_by: string | null
          hospital_id: string
          id: string
          is_deleted: boolean | null
          last_error: string | null
          next_attempt_at: string | null
          payload: Json
          provider: string
          requested_by: string | null
          result: Json
          status: string
          tenant_domain_id: string
          tenant_id: string | null
          updated_at: string
        }
        Insert: {
          attempt_count?: number
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          hospital_id: string
          id?: string
          is_deleted?: boolean | null
          last_error?: string | null
          next_attempt_at?: string | null
          payload?: Json
          provider?: string
          requested_by?: string | null
          result?: Json
          status?: string
          tenant_domain_id: string
          tenant_id?: string | null
          updated_at?: string
        }
        Update: {
          attempt_count?: number
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          hospital_id?: string
          id?: string
          is_deleted?: boolean | null
          last_error?: string | null
          next_attempt_at?: string | null
          payload?: Json
          provider?: string
          requested_by?: string | null
          result?: Json
          status?: string
          tenant_domain_id?: string
          tenant_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_provisioning_jobs_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_provisioning_jobs_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_provisioning_jobs_tenant_domain_id_fkey"
            columns: ["tenant_domain_id"]
            isOneToOne: false
            referencedRelation: "tenant_domains"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_provisioning_jobs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenants: {
        Row: {
          accepts_refill_requests: boolean | null
          address: string | null
          bed_capacity: number | null
          country: string | null
          country_code: string | null
          created_at: string | null
          custom_domain: string | null
          data_region: string | null
          default_subdomain: string | null
          district: string | null
          email: string | null
          facility_type: string | null
          id: string
          is_active: boolean | null
          is_network_member: boolean | null
          lat: number | null
          lng: number | null
          logo_url: string | null
          modules_enabled: string[] | null
          monthly_fee_ugx: number | null
          name: string
          network_listing_name: string | null
          onboarding_completed: boolean | null
          onboarding_step: number | null
          phone: string | null
          plan: string | null
          region: string | null
          settings: Json | null
          slug: string
          status: string | null
          subscription_end: string | null
          subscription_start: string | null
          tier: string | null
          trial_ends_at: string | null
          updated_at: string | null
        }
        Insert: {
          accepts_refill_requests?: boolean | null
          address?: string | null
          bed_capacity?: number | null
          country?: string | null
          country_code?: string | null
          created_at?: string | null
          custom_domain?: string | null
          data_region?: string | null
          default_subdomain?: string | null
          district?: string | null
          email?: string | null
          facility_type?: string | null
          id?: string
          is_active?: boolean | null
          is_network_member?: boolean | null
          lat?: number | null
          lng?: number | null
          logo_url?: string | null
          modules_enabled?: string[] | null
          monthly_fee_ugx?: number | null
          name: string
          network_listing_name?: string | null
          onboarding_completed?: boolean | null
          onboarding_step?: number | null
          phone?: string | null
          plan?: string | null
          region?: string | null
          settings?: Json | null
          slug: string
          status?: string | null
          subscription_end?: string | null
          subscription_start?: string | null
          tier?: string | null
          trial_ends_at?: string | null
          updated_at?: string | null
        }
        Update: {
          accepts_refill_requests?: boolean | null
          address?: string | null
          bed_capacity?: number | null
          country?: string | null
          country_code?: string | null
          created_at?: string | null
          custom_domain?: string | null
          data_region?: string | null
          default_subdomain?: string | null
          district?: string | null
          email?: string | null
          facility_type?: string | null
          id?: string
          is_active?: boolean | null
          is_network_member?: boolean | null
          lat?: number | null
          lng?: number | null
          logo_url?: string | null
          modules_enabled?: string[] | null
          monthly_fee_ugx?: number | null
          name?: string
          network_listing_name?: string | null
          onboarding_completed?: boolean | null
          onboarding_step?: number | null
          phone?: string | null
          plan?: string | null
          region?: string | null
          settings?: Json | null
          slug?: string
          status?: string | null
          subscription_end?: string | null
          subscription_start?: string | null
          tier?: string | null
          trial_ends_at?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      ucg_guidelines: {
        Row: {
          category: string
          content: string
          created_at: string | null
          created_by: string | null
          embedding: string | null
          guideline_code: string
          icd11_codes: string[]
          id: string
          is_deleted: boolean | null
          source_page: number | null
          subcategory: string | null
          tenant_id: string | null
          title: string
          updated_at: string | null
          version: string
        }
        Insert: {
          category: string
          content: string
          created_at?: string | null
          created_by?: string | null
          embedding?: string | null
          guideline_code: string
          icd11_codes?: string[]
          id?: string
          is_deleted?: boolean | null
          source_page?: number | null
          subcategory?: string | null
          tenant_id?: string | null
          title: string
          updated_at?: string | null
          version?: string
        }
        Update: {
          category?: string
          content?: string
          created_at?: string | null
          created_by?: string | null
          embedding?: string | null
          guideline_code?: string
          icd11_codes?: string[]
          id?: string
          is_deleted?: boolean | null
          source_page?: number | null
          subcategory?: string | null
          tenant_id?: string | null
          title?: string
          updated_at?: string | null
          version?: string
        }
        Relationships: [
          {
            foreignKeyName: "ucg_guidelines_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      verification_documents: {
        Row: {
          created_at: string
          created_by: string | null
          document_type: string
          document_url: string
          id: string
          is_deleted: boolean | null
          notes: string | null
          profile_id: string
          status: string
          tenant_id: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          document_type: string
          document_url: string
          id?: string
          is_deleted?: boolean | null
          notes?: string | null
          profile_id: string
          status?: string
          tenant_id?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          document_type?: string
          document_url?: string
          id?: string
          is_deleted?: boolean | null
          notes?: string | null
          profile_id?: string
          status?: string
          tenant_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "verification_documents_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "verification_documents_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      visitor_log: {
        Row: {
          badge_number: string | null
          host_name: string | null
          host_staff_id: string | null
          id: string
          logged_by: string | null
          national_id: string | null
          notes: string | null
          purpose: string | null
          tenant_id: string
          time_in: string | null
          time_out: string | null
          vehicle_reg: string | null
          visitor_name: string
        }
        Insert: {
          badge_number?: string | null
          host_name?: string | null
          host_staff_id?: string | null
          id?: string
          logged_by?: string | null
          national_id?: string | null
          notes?: string | null
          purpose?: string | null
          tenant_id: string
          time_in?: string | null
          time_out?: string | null
          vehicle_reg?: string | null
          visitor_name: string
        }
        Update: {
          badge_number?: string | null
          host_name?: string | null
          host_staff_id?: string | null
          id?: string
          logged_by?: string | null
          national_id?: string | null
          notes?: string | null
          purpose?: string | null
          tenant_id?: string
          time_in?: string | null
          time_out?: string | null
          vehicle_reg?: string | null
          visitor_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "visitor_log_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      vitals: {
        Row: {
          alt: number | null
          ast: number | null
          bp_diastolic: number | null
          bp_systolic: number | null
          created_at: string
          created_by: string | null
          creatinine: number | null
          creatinine_clearance: number | null
          egfr: number | null
          encounter_id: string
          heart_rate: number | null
          height_cm: number | null
          id: string
          is_deleted: boolean | null
          notes: string | null
          recorded_at: string
          recorded_by: string | null
          respiratory_rate: number | null
          spo2: number | null
          temperature_c: number | null
          tenant_id: string | null
          updated_at: string | null
          version: number
          weight_kg: number | null
        }
        Insert: {
          alt?: number | null
          ast?: number | null
          bp_diastolic?: number | null
          bp_systolic?: number | null
          created_at?: string
          created_by?: string | null
          creatinine?: number | null
          creatinine_clearance?: number | null
          egfr?: number | null
          encounter_id: string
          heart_rate?: number | null
          height_cm?: number | null
          id?: string
          is_deleted?: boolean | null
          notes?: string | null
          recorded_at?: string
          recorded_by?: string | null
          respiratory_rate?: number | null
          spo2?: number | null
          temperature_c?: number | null
          tenant_id?: string | null
          updated_at?: string | null
          version?: number
          weight_kg?: number | null
        }
        Update: {
          alt?: number | null
          ast?: number | null
          bp_diastolic?: number | null
          bp_systolic?: number | null
          created_at?: string
          created_by?: string | null
          creatinine?: number | null
          creatinine_clearance?: number | null
          egfr?: number | null
          encounter_id?: string
          heart_rate?: number | null
          height_cm?: number | null
          id?: string
          is_deleted?: boolean | null
          notes?: string | null
          recorded_at?: string
          recorded_by?: string | null
          respiratory_rate?: number | null
          spo2?: number | null
          temperature_c?: number | null
          tenant_id?: string | null
          updated_at?: string | null
          version?: number
          weight_kg?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "vitals_encounter_id_fkey"
            columns: ["encounter_id"]
            isOneToOne: false
            referencedRelation: "encounters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vitals_recorded_by_fkey"
            columns: ["recorded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vitals_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      wards: {
        Row: {
          capacity: number
          created_at: string
          hospital_id: string
          id: string
          is_active: boolean
          name: string
        }
        Insert: {
          capacity?: number
          created_at?: string
          hospital_id: string
          id?: string
          is_active?: boolean
          name: string
        }
        Update: {
          capacity?: number
          created_at?: string
          hospital_id?: string
          id?: string
          is_active?: boolean
          name?: string
        }
        Relationships: [
          {
            foreignKeyName: "wards_hospital_id_fkey"
            columns: ["hospital_id"]
            isOneToOne: false
            referencedRelation: "hospitals"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      check_death_sentinel: {
        Args: { p_hospital_id: string }
        Returns: {
          alert_type: string
          earliest_death: string
          icd11_codes: string[]
          latest_death: string
          trigger_count: number
          window_hours: number
        }[]
      }
      claim_next_consult: {
        Args: { p_doctor_id: string }
        Returns: {
          assigned_doctor_id: string | null
          case_id: string | null
          chief_complaint: string | null
          claimed_at: string | null
          completed_at: string | null
          created_at: string
          estimated_wait_minutes: number | null
          guest_key: string | null
          id: string
          position: number | null
          specialty_requested: string | null
          status: string
          token: string
          updated_at: string
          urgency: string
        }[]
        SetofOptions: {
          from: "*"
          to: "consult_queue"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      current_tenant_id: { Args: never; Returns: string }
      custom_access_token_hook: { Args: { event: Json }; Returns: Json }
      find_duplicate_patients: {
        Args: {
          p_dob?: string
          p_full_name: string
          p_hospital_id: string
          p_nin_hash?: string
          p_phone_hash?: string
          p_similarity_threshold?: number
        }
        Returns: {
          dob: string
          full_name: string
          id: string
          match_reason: string
          mrn: string
          similarity: number
        }[]
      }
      generate_synapse_id: { Args: never; Returns: string }
      get_available_beds: {
        Args: { p_bed_type?: string; p_hospital_id?: string }
        Returns: {
          available_count: number
          bed_type: string
          hospital_id: string
          hospital_name: string
        }[]
      }
      get_queue_position: { Args: { p_id: string }; Returns: number }
      has_patient_consent: {
        Args: { p_actor_id?: string; p_module: string; p_patient_id: string }
        Returns: boolean
      }
      is_admin: { Args: { _uid: string }; Returns: boolean }
      is_clinical_staff: { Args: never; Returns: boolean }
      is_platform_admin: { Args: never; Returns: boolean }
      match_ucg_guidelines: {
        Args: {
          match_count?: number
          match_threshold?: number
          query_embedding: string
        }
        Returns: {
          category: string
          content: string
          guideline_code: string
          icd11_codes: string[]
          id: string
          similarity: number
          title: string
        }[]
      }
      resolve_tenant_from_host: {
        Args: { input_host: string }
        Returns: {
          domain: string
          hospital_id: string
          is_active: boolean
          matched_subdomain: string
          tenant_key: string
        }[]
      }
      show_limit: { Args: never; Returns: number }
      show_trgm: { Args: { "": string }; Returns: string[] }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const

