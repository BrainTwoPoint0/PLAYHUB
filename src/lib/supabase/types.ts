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
    PostgrestVersion: '12.2.3 (519615d)'
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      basketball_player_profiles: {
        Row: {
          created_at: string | null
          device_metrics: Json | null
          experience_level: Database['public']['Enums']['basketball_experience_level']
          id: string
          metadata: Json | null
          preferred_hand: string | null
          preferred_jersey_number: number | null
          primary_position: string | null
          profile_variant_id: string
          secondary_positions: string[] | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          device_metrics?: Json | null
          experience_level: Database['public']['Enums']['basketball_experience_level']
          id?: string
          metadata?: Json | null
          preferred_hand?: string | null
          preferred_jersey_number?: number | null
          primary_position?: string | null
          profile_variant_id: string
          secondary_positions?: string[] | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          device_metrics?: Json | null
          experience_level?: Database['public']['Enums']['basketball_experience_level']
          id?: string
          metadata?: Json | null
          preferred_hand?: string | null
          preferred_jersey_number?: number | null
          primary_position?: string | null
          profile_variant_id?: string
          secondary_positions?: string[] | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'basketball_player_profiles_profile_variant_id_fkey'
            columns: ['profile_variant_id']
            isOneToOne: true
            referencedRelation: 'profile_variants'
            referencedColumns: ['id']
          },
        ]
      }
      career_history: {
        Row: {
          achievements: string[] | null
          created_at: string | null
          description: string | null
          display_order: number | null
          end_date: string | null
          id: string
          is_current: boolean | null
          organization_id: string | null
          organization_name: string | null
          profile_variant_id: string
          role: string | null
          start_date: string | null
          updated_at: string | null
          verified: boolean | null
        }
        Insert: {
          achievements?: string[] | null
          created_at?: string | null
          description?: string | null
          display_order?: number | null
          end_date?: string | null
          id?: string
          is_current?: boolean | null
          organization_id?: string | null
          organization_name?: string | null
          profile_variant_id: string
          role?: string | null
          start_date?: string | null
          updated_at?: string | null
          verified?: boolean | null
        }
        Update: {
          achievements?: string[] | null
          created_at?: string | null
          description?: string | null
          display_order?: number | null
          end_date?: string | null
          id?: string
          is_current?: boolean | null
          organization_id?: string | null
          organization_name?: string | null
          profile_variant_id?: string
          role?: string | null
          start_date?: string | null
          updated_at?: string | null
          verified?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: 'career_history_organization_id_fkey'
            columns: ['organization_id']
            isOneToOne: false
            referencedRelation: 'organizations'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'career_history_profile_variant_id_fkey'
            columns: ['profile_variant_id']
            isOneToOne: false
            referencedRelation: 'profile_variants'
            referencedColumns: ['id']
          },
        ]
      }
      clip_attributions: {
        Row: {
          attributed_at: string
          clip_id: string
          confidence: number | null
          created_at: string
          id: string
          jersey_number_at_match: number | null
          profile_id: string
          revocation_note: string | null
          revoked_at: string | null
          revoked_by: Database['public']['Enums']['attribution_revoker'] | null
          source: Database['public']['Enums']['attribution_source']
          updated_at: string
        }
        Insert: {
          attributed_at?: string
          clip_id: string
          confidence?: number | null
          created_at?: string
          id?: string
          jersey_number_at_match?: number | null
          profile_id: string
          revocation_note?: string | null
          revoked_at?: string | null
          revoked_by?: Database['public']['Enums']['attribution_revoker'] | null
          source?: Database['public']['Enums']['attribution_source']
          updated_at?: string
        }
        Update: {
          attributed_at?: string
          clip_id?: string
          confidence?: number | null
          created_at?: string
          id?: string
          jersey_number_at_match?: number | null
          profile_id?: string
          revocation_note?: string | null
          revoked_at?: string | null
          revoked_by?: Database['public']['Enums']['attribution_revoker'] | null
          source?: Database['public']['Enums']['attribution_source']
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'clip_attributions_clip_id_fkey'
            columns: ['clip_id']
            isOneToOne: false
            referencedRelation: 'clips'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'clip_attributions_profile_id_fkey'
            columns: ['profile_id']
            isOneToOne: false
            referencedRelation: 'profiles'
            referencedColumns: ['id']
          },
        ]
      }
      clips: {
        Row: {
          created_at: string
          deleted_at: string | null
          description: string | null
          id: string
          jersey_number_meta: number | null
          metadata: Json
          offset_end_ms: number
          offset_start_ms: number
          owner_org_id: string
          recording_id: string
          title: string | null
          type: Database['public']['Enums']['clip_type']
          updated_at: string
        }
        Insert: {
          created_at?: string
          deleted_at?: string | null
          description?: string | null
          id?: string
          jersey_number_meta?: number | null
          metadata?: Json
          offset_end_ms: number
          offset_start_ms: number
          owner_org_id: string
          recording_id: string
          title?: string | null
          type?: Database['public']['Enums']['clip_type']
          updated_at?: string
        }
        Update: {
          created_at?: string
          deleted_at?: string | null
          description?: string | null
          id?: string
          jersey_number_meta?: number | null
          metadata?: Json
          offset_end_ms?: number
          offset_start_ms?: number
          owner_org_id?: string
          recording_id?: string
          title?: string | null
          type?: Database['public']['Enums']['clip_type']
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'clips_owner_org_id_fkey'
            columns: ['owner_org_id']
            isOneToOne: false
            referencedRelation: 'organizations'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'clips_recording_id_fkey'
            columns: ['recording_id']
            isOneToOne: false
            referencedRelation: 'playhub_match_recordings'
            referencedColumns: ['id']
          },
        ]
      }
      coach_modules: {
        Row: {
          age_groups: string[]
          coaching_philosophy: string | null
          created_at: string
          metadata: Json
          profile_variant_id: string
          qualifications: Json
          sports_coached: string[]
          updated_at: string
        }
        Insert: {
          age_groups?: string[]
          coaching_philosophy?: string | null
          created_at?: string
          metadata?: Json
          profile_variant_id: string
          qualifications?: Json
          sports_coached?: string[]
          updated_at?: string
        }
        Update: {
          age_groups?: string[]
          coaching_philosophy?: string | null
          created_at?: string
          metadata?: Json
          profile_variant_id?: string
          qualifications?: Json
          sports_coached?: string[]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'coach_modules_profile_variant_id_fkey'
            columns: ['profile_variant_id']
            isOneToOne: true
            referencedRelation: 'profile_variants'
            referencedColumns: ['id']
          },
        ]
      }
      connections: {
        Row: {
          created_at: string | null
          id: string
          message: string | null
          recipient_id: string | null
          requester_id: string | null
          status: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          id?: string
          message?: string | null
          recipient_id?: string | null
          requester_id?: string | null
          status?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          id?: string
          message?: string | null
          recipient_id?: string | null
          requester_id?: string | null
          status?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'connections_recipient_id_fkey'
            columns: ['recipient_id']
            isOneToOne: false
            referencedRelation: 'profiles'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'connections_requester_id_fkey'
            columns: ['requester_id']
            isOneToOne: false
            referencedRelation: 'profiles'
            referencedColumns: ['id']
          },
        ]
      }
      education: {
        Row: {
          achievements: string[] | null
          created_at: string | null
          degree_or_program: string | null
          description: string | null
          display_order: number | null
          end_date: string | null
          field_of_study: string | null
          id: string
          institution_name: string
          institution_type: string | null
          is_current: boolean | null
          profile_id: string
          start_date: string | null
          updated_at: string | null
          verified: boolean | null
        }
        Insert: {
          achievements?: string[] | null
          created_at?: string | null
          degree_or_program?: string | null
          description?: string | null
          display_order?: number | null
          end_date?: string | null
          field_of_study?: string | null
          id?: string
          institution_name: string
          institution_type?: string | null
          is_current?: boolean | null
          profile_id: string
          start_date?: string | null
          updated_at?: string | null
          verified?: boolean | null
        }
        Update: {
          achievements?: string[] | null
          created_at?: string | null
          degree_or_program?: string | null
          description?: string | null
          display_order?: number | null
          end_date?: string | null
          field_of_study?: string | null
          id?: string
          institution_name?: string
          institution_type?: string | null
          is_current?: boolean | null
          profile_id?: string
          start_date?: string | null
          updated_at?: string | null
          verified?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: 'education_profile_id_fkey'
            columns: ['profile_id']
            isOneToOne: false
            referencedRelation: 'profiles'
            referencedColumns: ['id']
          },
        ]
      }
      football_player_profiles: {
        Row: {
          created_at: string | null
          experience_level: Database['public']['Enums']['football_experience_level']
          id: string
          metadata: Json | null
          player_data_metrics: Json | null
          preferred_foot: string | null
          preferred_jersey_number: number | null
          primary_position: string | null
          profile_variant_id: string
          secondary_positions: string[] | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          experience_level: Database['public']['Enums']['football_experience_level']
          id?: string
          metadata?: Json | null
          player_data_metrics?: Json | null
          preferred_foot?: string | null
          preferred_jersey_number?: number | null
          primary_position?: string | null
          profile_variant_id: string
          secondary_positions?: string[] | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          experience_level?: Database['public']['Enums']['football_experience_level']
          id?: string
          metadata?: Json | null
          player_data_metrics?: Json | null
          preferred_foot?: string | null
          preferred_jersey_number?: number | null
          primary_position?: string | null
          profile_variant_id?: string
          secondary_positions?: string[] | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'football_player_profiles_profile_variant_id_fkey'
            columns: ['profile_variant_id']
            isOneToOne: true
            referencedRelation: 'profile_variants'
            referencedColumns: ['id']
          },
        ]
      }
      highlights: {
        Row: {
          created_at: string | null
          description: string | null
          duration: number | null
          id: string
          is_public: boolean | null
          like_count: number | null
          metadata: Json | null
          profile_id: string | null
          profile_variant_id: string | null
          sport_id: string | null
          tags: string[] | null
          thumbnail_url: string | null
          title: string
          updated_at: string | null
          video_url: string
          view_count: number | null
        }
        Insert: {
          created_at?: string | null
          description?: string | null
          duration?: number | null
          id?: string
          is_public?: boolean | null
          like_count?: number | null
          metadata?: Json | null
          profile_id?: string | null
          profile_variant_id?: string | null
          sport_id?: string | null
          tags?: string[] | null
          thumbnail_url?: string | null
          title: string
          updated_at?: string | null
          video_url: string
          view_count?: number | null
        }
        Update: {
          created_at?: string | null
          description?: string | null
          duration?: number | null
          id?: string
          is_public?: boolean | null
          like_count?: number | null
          metadata?: Json | null
          profile_id?: string | null
          profile_variant_id?: string | null
          sport_id?: string | null
          tags?: string[] | null
          thumbnail_url?: string | null
          title?: string
          updated_at?: string | null
          video_url?: string
          view_count?: number | null
        }
        Relationships: [
          {
            foreignKeyName: 'highlights_profile_id_fkey'
            columns: ['profile_id']
            isOneToOne: false
            referencedRelation: 'profiles'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'highlights_profile_variant_id_fkey'
            columns: ['profile_variant_id']
            isOneToOne: false
            referencedRelation: 'profile_variants'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'highlights_sport_id_fkey'
            columns: ['sport_id']
            isOneToOne: false
            referencedRelation: 'sports'
            referencedColumns: ['id']
          },
        ]
      }
      match_jersey_maps: {
        Row: {
          club_org_id: string
          created_at: string
          id: string
          jersey_number: number
          locked_at: string | null
          mapped_at: string
          mapped_by_membership_id: string | null
          notes: string | null
          profile_id: string | null
          recording_id: string
          updated_at: string
        }
        Insert: {
          club_org_id: string
          created_at?: string
          id?: string
          jersey_number: number
          locked_at?: string | null
          mapped_at?: string
          mapped_by_membership_id?: string | null
          notes?: string | null
          profile_id?: string | null
          recording_id: string
          updated_at?: string
        }
        Update: {
          club_org_id?: string
          created_at?: string
          id?: string
          jersey_number?: number
          locked_at?: string | null
          mapped_at?: string
          mapped_by_membership_id?: string | null
          notes?: string | null
          profile_id?: string | null
          recording_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'match_jersey_maps_club_org_id_fkey'
            columns: ['club_org_id']
            isOneToOne: false
            referencedRelation: 'organizations'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'match_jersey_maps_mapped_by_membership_id_fkey'
            columns: ['mapped_by_membership_id']
            isOneToOne: false
            referencedRelation: 'organization_members'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'match_jersey_maps_profile_id_fkey'
            columns: ['profile_id']
            isOneToOne: false
            referencedRelation: 'profiles'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'match_jersey_maps_recording_id_fkey'
            columns: ['recording_id']
            isOneToOne: false
            referencedRelation: 'playhub_match_recordings'
            referencedColumns: ['id']
          },
        ]
      }
      newsletter_subscribers: {
        Row: {
          confirmation_sent_at: string | null
          confirmation_token: string | null
          confirmed_at: string | null
          created_at: string
          email: string
          id: string
          ip_hash: string | null
          metadata: Json
          resend_contact_id: string | null
          resend_sync_attempts: number
          resend_synced_at: string | null
          role: string | null
          source: string | null
          status: string
          unsubscribed_at: string | null
          updated_at: string
          user_agent: string | null
        }
        Insert: {
          confirmation_sent_at?: string | null
          confirmation_token?: string | null
          confirmed_at?: string | null
          created_at?: string
          email: string
          id?: string
          ip_hash?: string | null
          metadata?: Json
          resend_contact_id?: string | null
          resend_sync_attempts?: number
          resend_synced_at?: string | null
          role?: string | null
          source?: string | null
          status?: string
          unsubscribed_at?: string | null
          updated_at?: string
          user_agent?: string | null
        }
        Update: {
          confirmation_sent_at?: string | null
          confirmation_token?: string | null
          confirmed_at?: string | null
          created_at?: string
          email?: string
          id?: string
          ip_hash?: string | null
          metadata?: Json
          resend_contact_id?: string | null
          resend_sync_attempts?: number
          resend_synced_at?: string | null
          role?: string | null
          source?: string | null
          status?: string
          unsubscribed_at?: string | null
          updated_at?: string
          user_agent?: string | null
        }
        Relationships: []
      }
      organization_members: {
        Row: {
          contract_end: string | null
          contract_start: string | null
          created_at: string | null
          id: string
          is_active: boolean | null
          jersey_number: number | null
          metadata: Json | null
          organization_id: string | null
          permissions: Json | null
          profile_id: string | null
          profile_variant_id: string | null
          role: Database['public']['Enums']['profile_variant_type']
          updated_at: string | null
        }
        Insert: {
          contract_end?: string | null
          contract_start?: string | null
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          jersey_number?: number | null
          metadata?: Json | null
          organization_id?: string | null
          permissions?: Json | null
          profile_id?: string | null
          profile_variant_id?: string | null
          role: Database['public']['Enums']['profile_variant_type']
          updated_at?: string | null
        }
        Update: {
          contract_end?: string | null
          contract_start?: string | null
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          jersey_number?: number | null
          metadata?: Json | null
          organization_id?: string | null
          permissions?: Json | null
          profile_id?: string | null
          profile_variant_id?: string | null
          role?: Database['public']['Enums']['profile_variant_type']
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'organization_members_organization_id_fkey'
            columns: ['organization_id']
            isOneToOne: false
            referencedRelation: 'organizations'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'organization_members_profile_id_fkey'
            columns: ['profile_id']
            isOneToOne: false
            referencedRelation: 'profiles'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'organization_members_profile_variant_id_fkey'
            columns: ['profile_variant_id']
            isOneToOne: false
            referencedRelation: 'profile_variants'
            referencedColumns: ['id']
          },
        ]
      }
      organization_venue_access: {
        Row: {
          billing_responsibility: string | null
          can_record: boolean | null
          can_stream: boolean | null
          created_at: string | null
          custom_billable_amount: number | null
          custom_currency: string | null
          default_graphic_package_id: string | null
          expires_at: string | null
          id: string
          is_active: boolean | null
          notes: string | null
          organization_id: string
          starts_at: string | null
          updated_at: string | null
          venue_organization_id: string
        }
        Insert: {
          billing_responsibility?: string | null
          can_record?: boolean | null
          can_stream?: boolean | null
          created_at?: string | null
          custom_billable_amount?: number | null
          custom_currency?: string | null
          default_graphic_package_id?: string | null
          expires_at?: string | null
          id?: string
          is_active?: boolean | null
          notes?: string | null
          organization_id: string
          starts_at?: string | null
          updated_at?: string | null
          venue_organization_id: string
        }
        Update: {
          billing_responsibility?: string | null
          can_record?: boolean | null
          can_stream?: boolean | null
          created_at?: string | null
          custom_billable_amount?: number | null
          custom_currency?: string | null
          default_graphic_package_id?: string | null
          expires_at?: string | null
          id?: string
          is_active?: boolean | null
          notes?: string | null
          organization_id?: string
          starts_at?: string | null
          updated_at?: string | null
          venue_organization_id?: string
        }
        Relationships: [
          {
            foreignKeyName: 'organization_venue_access_default_graphic_package_id_fkey'
            columns: ['default_graphic_package_id']
            isOneToOne: false
            referencedRelation: 'playhub_graphic_packages'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'organization_venue_access_organization_id_fkey'
            columns: ['organization_id']
            isOneToOne: false
            referencedRelation: 'organizations'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'organization_venue_access_venue_organization_id_fkey'
            columns: ['venue_organization_id']
            isOneToOne: false
            referencedRelation: 'organizations'
            referencedColumns: ['id']
          },
        ]
      }
      organizations: {
        Row: {
          contact_info: Json | null
          country_code: string | null
          cover_image_url: string | null
          created_at: string | null
          created_by: string | null
          default_price_amount: number | null
          default_price_currency: string | null
          description: string | null
          feature_graphic_packages: boolean | null
          feature_recordings: boolean | null
          feature_streaming: boolean | null
          founded_year: number | null
          id: string
          is_active: boolean | null
          is_verified: boolean | null
          level: string | null
          location: string | null
          logo_url: string | null
          marketplace_enabled: boolean | null
          member_count: number | null
          name: string
          parent_organization_id: string | null
          settings: Json | null
          slug: string
          social_links: Json | null
          sport_ids: string[] | null
          type: string
          updated_at: string | null
          website: string | null
        }
        Insert: {
          contact_info?: Json | null
          country_code?: string | null
          cover_image_url?: string | null
          created_at?: string | null
          created_by?: string | null
          default_price_amount?: number | null
          default_price_currency?: string | null
          description?: string | null
          feature_graphic_packages?: boolean | null
          feature_recordings?: boolean | null
          feature_streaming?: boolean | null
          founded_year?: number | null
          id?: string
          is_active?: boolean | null
          is_verified?: boolean | null
          level?: string | null
          location?: string | null
          logo_url?: string | null
          marketplace_enabled?: boolean | null
          member_count?: number | null
          name: string
          parent_organization_id?: string | null
          settings?: Json | null
          slug: string
          social_links?: Json | null
          sport_ids?: string[] | null
          type: string
          updated_at?: string | null
          website?: string | null
        }
        Update: {
          contact_info?: Json | null
          country_code?: string | null
          cover_image_url?: string | null
          created_at?: string | null
          created_by?: string | null
          default_price_amount?: number | null
          default_price_currency?: string | null
          description?: string | null
          feature_graphic_packages?: boolean | null
          feature_recordings?: boolean | null
          feature_streaming?: boolean | null
          founded_year?: number | null
          id?: string
          is_active?: boolean | null
          is_verified?: boolean | null
          level?: string | null
          location?: string | null
          logo_url?: string | null
          marketplace_enabled?: boolean | null
          member_count?: number | null
          name?: string
          parent_organization_id?: string | null
          settings?: Json | null
          slug?: string
          social_links?: Json | null
          sport_ids?: string[] | null
          type?: string
          updated_at?: string | null
          website?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'organizations_created_by_fkey'
            columns: ['created_by']
            isOneToOne: false
            referencedRelation: 'profiles'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'organizations_parent_organization_id_fkey'
            columns: ['parent_organization_id']
            isOneToOne: false
            referencedRelation: 'organizations'
            referencedColumns: ['id']
          },
        ]
      }
      playerdata_connections: {
        Row: {
          access_token: string
          created_at: string | null
          expires_at: string
          id: string
          is_active: boolean | null
          refresh_token: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          access_token: string
          created_at?: string | null
          expires_at: string
          id?: string
          is_active?: boolean | null
          refresh_token: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          access_token?: string
          created_at?: string | null
          expires_at?: string
          id?: string
          is_active?: boolean | null
          refresh_token?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      playhub_academy_config: {
        Row: {
          additional_stripe_product_ids: string[] | null
          club_slug: string
          created_at: string | null
          display_price: string | null
          has_scholarships: boolean | null
          id: string
          is_active: boolean | null
          logo_url: string | null
          name: string
          organization_id: string | null
          registration_fee_stripe_price_id: string | null
          stripe_product_id: string
          updated_at: string | null
          veo_club_slug: string | null
        }
        Insert: {
          additional_stripe_product_ids?: string[] | null
          club_slug: string
          created_at?: string | null
          display_price?: string | null
          has_scholarships?: boolean | null
          id?: string
          is_active?: boolean | null
          logo_url?: string | null
          name: string
          organization_id?: string | null
          registration_fee_stripe_price_id?: string | null
          stripe_product_id: string
          updated_at?: string | null
          veo_club_slug?: string | null
        }
        Update: {
          additional_stripe_product_ids?: string[] | null
          club_slug?: string
          created_at?: string | null
          display_price?: string | null
          has_scholarships?: boolean | null
          id?: string
          is_active?: boolean | null
          logo_url?: string | null
          name?: string
          organization_id?: string | null
          registration_fee_stripe_price_id?: string | null
          stripe_product_id?: string
          updated_at?: string | null
          veo_club_slug?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'playhub_academy_config_organization_id_fkey'
            columns: ['organization_id']
            isOneToOne: false
            referencedRelation: 'organizations'
            referencedColumns: ['id']
          },
        ]
      }
      playhub_academy_subclubs: {
        Row: {
          club_slug: string
          created_at: string
          display_name: string
          id: string
          is_active: boolean
          logo_url: string | null
          sort_order: number
          subclub_slug: string
          updated_at: string
          veo_club_slug: string | null
        }
        Insert: {
          club_slug: string
          created_at?: string
          display_name: string
          id?: string
          is_active?: boolean
          logo_url?: string | null
          sort_order?: number
          subclub_slug: string
          updated_at?: string
          veo_club_slug?: string | null
        }
        Update: {
          club_slug?: string
          created_at?: string
          display_name?: string
          id?: string
          is_active?: boolean
          logo_url?: string | null
          sort_order?: number
          subclub_slug?: string
          updated_at?: string
          veo_club_slug?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'playhub_academy_subclubs_club_slug_fkey'
            columns: ['club_slug']
            isOneToOne: false
            referencedRelation: 'playhub_academy_config'
            referencedColumns: ['club_slug']
          },
        ]
      }
      playhub_academy_subscriptions: {
        Row: {
          club_slug: string
          created_at: string
          current_period_end: string | null
          customer_email: string
          customer_name: string | null
          id: string
          player_name: string | null
          provision_attempted_at: string | null
          provision_attempts: number
          provisioned_at: string | null
          provisioning_dispatched_at: string | null
          provisioning_error: string | null
          registration_subclub: string | null
          registration_team: string | null
          status: string
          stripe_customer_id: string
          stripe_subscription_id: string
          subscriber_type: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          club_slug: string
          created_at?: string
          current_period_end?: string | null
          customer_email: string
          customer_name?: string | null
          id?: string
          player_name?: string | null
          provision_attempted_at?: string | null
          provision_attempts?: number
          provisioned_at?: string | null
          provisioning_dispatched_at?: string | null
          provisioning_error?: string | null
          registration_subclub?: string | null
          registration_team?: string | null
          status: string
          stripe_customer_id: string
          stripe_subscription_id: string
          subscriber_type?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          club_slug?: string
          created_at?: string
          current_period_end?: string | null
          customer_email?: string
          customer_name?: string | null
          id?: string
          player_name?: string | null
          provision_attempted_at?: string | null
          provision_attempts?: number
          provisioned_at?: string | null
          provisioning_dispatched_at?: string | null
          provisioning_error?: string | null
          registration_subclub?: string | null
          registration_team?: string | null
          status?: string
          stripe_customer_id?: string
          stripe_subscription_id?: string
          subscriber_type?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: 'playhub_academy_subscriptions_club_slug_fkey'
            columns: ['club_slug']
            isOneToOne: false
            referencedRelation: 'playhub_academy_config'
            referencedColumns: ['club_slug']
          },
        ]
      }
      playhub_academy_teams: {
        Row: {
          club_slug: string
          created_at: string
          display_name: string
          id: string
          is_active: boolean
          logo_url: string | null
          sort_order: number
          subclub_slug: string | null
          team_slug: string
          updated_at: string
          veo_team_slug: string | null
        }
        Insert: {
          club_slug: string
          created_at?: string
          display_name: string
          id?: string
          is_active?: boolean
          logo_url?: string | null
          sort_order?: number
          subclub_slug?: string | null
          team_slug: string
          updated_at?: string
          veo_team_slug?: string | null
        }
        Update: {
          club_slug?: string
          created_at?: string
          display_name?: string
          id?: string
          is_active?: boolean
          logo_url?: string | null
          sort_order?: number
          subclub_slug?: string | null
          team_slug?: string
          updated_at?: string
          veo_team_slug?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'playhub_academy_teams_club_slug_fkey'
            columns: ['club_slug']
            isOneToOne: false
            referencedRelation: 'playhub_academy_config'
            referencedColumns: ['club_slug']
          },
          {
            foreignKeyName: 'playhub_academy_teams_subclub_fk'
            columns: ['club_slug', 'subclub_slug']
            isOneToOne: false
            referencedRelation: 'playhub_academy_subclubs'
            referencedColumns: ['club_slug', 'subclub_slug']
          },
        ]
      }
      playhub_access_rights: {
        Row: {
          expires_at: string | null
          granted_at: string | null
          granted_by: string | null
          id: string
          invited_email: string | null
          is_active: boolean | null
          match_recording_id: string | null
          notes: string | null
          profile_id: string | null
          purchase_id: string | null
          revoked_at: string | null
          revoked_reason: string | null
          updated_at: string | null
          user_id: string | null
        }
        Insert: {
          expires_at?: string | null
          granted_at?: string | null
          granted_by?: string | null
          id?: string
          invited_email?: string | null
          is_active?: boolean | null
          match_recording_id?: string | null
          notes?: string | null
          profile_id?: string | null
          purchase_id?: string | null
          revoked_at?: string | null
          revoked_reason?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Update: {
          expires_at?: string | null
          granted_at?: string | null
          granted_by?: string | null
          id?: string
          invited_email?: string | null
          is_active?: boolean | null
          match_recording_id?: string | null
          notes?: string | null
          profile_id?: string | null
          purchase_id?: string | null
          revoked_at?: string | null
          revoked_reason?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'playhub_access_rights_match_recording_id_fkey'
            columns: ['match_recording_id']
            isOneToOne: false
            referencedRelation: 'playhub_match_recordings'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'playhub_access_rights_profile_id_fkey'
            columns: ['profile_id']
            isOneToOne: false
            referencedRelation: 'profiles'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'playhub_access_rights_purchase_id_fkey'
            columns: ['purchase_id']
            isOneToOne: false
            referencedRelation: 'playhub_purchases'
            referencedColumns: ['id']
          },
        ]
      }
      playhub_audit_log: {
        Row: {
          action: string
          actor_user_id: string | null
          created_at: string
          id: string
          metadata: Json | null
          target_id: string | null
          target_organization_id: string | null
          target_recording_id: string | null
          target_type: string
          was_admin_override: boolean
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          created_at?: string
          id?: string
          metadata?: Json | null
          target_id?: string | null
          target_organization_id?: string | null
          target_recording_id?: string | null
          target_type: string
          was_admin_override?: boolean
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          created_at?: string
          id?: string
          metadata?: Json | null
          target_id?: string | null
          target_organization_id?: string | null
          target_recording_id?: string | null
          target_type?: string
          was_admin_override?: boolean
        }
        Relationships: [
          {
            foreignKeyName: 'playhub_audit_log_target_organization_id_fkey'
            columns: ['target_organization_id']
            isOneToOne: false
            referencedRelation: 'organizations'
            referencedColumns: ['id']
          },
        ]
      }
      playhub_clutch_player_labels: {
        Row: {
          created_at: string
          display_name: string
          id: string
          labeled_by: string | null
          match_recording_id: string
          provider_player_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          display_name: string
          id?: string
          labeled_by?: string | null
          match_recording_id: string
          provider_player_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          display_name?: string
          id?: string
          labeled_by?: string | null
          match_recording_id?: string
          provider_player_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'playhub_clutch_player_labels_match_recording_id_fkey'
            columns: ['match_recording_id']
            isOneToOne: false
            referencedRelation: 'playhub_match_recordings'
            referencedColumns: ['id']
          },
        ]
      }
      playhub_crop_detections: {
        Row: {
          created_at: string
          detection: Json
          modal_app_version: string | null
          modal_inference_ms: number | null
          updated_at: string
          veo_highlight_id: string
        }
        Insert: {
          created_at?: string
          detection: Json
          modal_app_version?: string | null
          modal_inference_ms?: number | null
          updated_at?: string
          veo_highlight_id: string
        }
        Update: {
          created_at?: string
          detection?: Json
          modal_app_version?: string | null
          modal_inference_ms?: number | null
          updated_at?: string
          veo_highlight_id?: string
        }
        Relationships: []
      }
      playhub_crop_feedback: {
        Row: {
          action: string
          created_at: string
          id: string
          job_id: string
          keyframes_after: Json | null
          keyframes_before: Json | null
          note: string | null
          user_id: string
        }
        Insert: {
          action: string
          created_at?: string
          id?: string
          job_id: string
          keyframes_after?: Json | null
          keyframes_before?: Json | null
          note?: string | null
          user_id: string
        }
        Update: {
          action?: string
          created_at?: string
          id?: string
          job_id?: string
          keyframes_after?: Json | null
          keyframes_before?: Json | null
          note?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: 'playhub_crop_feedback_job_id_fkey'
            columns: ['job_id']
            isOneToOne: false
            referencedRelation: 'playhub_crop_jobs'
            referencedColumns: ['id']
          },
        ]
      }
      playhub_crop_jobs: {
        Row: {
          codec_fingerprint: Json | null
          created_at: string
          error_code: string | null
          error_message: string | null
          id: string
          modal_app_version: string | null
          modal_inference_ms: number | null
          output_storage_path: string | null
          recording_id: string | null
          scene_changes: number[]
          status: string
          updated_at: string
          user_id: string
          video_url: string | null
        }
        Insert: {
          codec_fingerprint?: Json | null
          created_at?: string
          error_code?: string | null
          error_message?: string | null
          id?: string
          modal_app_version?: string | null
          modal_inference_ms?: number | null
          output_storage_path?: string | null
          recording_id?: string | null
          scene_changes?: number[]
          status?: string
          updated_at?: string
          user_id: string
          video_url?: string | null
        }
        Update: {
          codec_fingerprint?: Json | null
          created_at?: string
          error_code?: string | null
          error_message?: string | null
          id?: string
          modal_app_version?: string | null
          modal_inference_ms?: number | null
          output_storage_path?: string | null
          recording_id?: string | null
          scene_changes?: number[]
          status?: string
          updated_at?: string
          user_id?: string
          video_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'playhub_crop_jobs_recording_id_fkey'
            columns: ['recording_id']
            isOneToOne: false
            referencedRelation: 'playhub_match_recordings'
            referencedColumns: ['id']
          },
        ]
      }
      playhub_crop_keyframes: {
        Row: {
          confidence: number
          created_at: string
          edited_at: string | null
          edited_by_user: boolean
          id: string
          job_id: string
          source: string
          time_seconds: number
          x_pixels: number
        }
        Insert: {
          confidence?: number
          created_at?: string
          edited_at?: string | null
          edited_by_user?: boolean
          id?: string
          job_id: string
          source: string
          time_seconds: number
          x_pixels: number
        }
        Update: {
          confidence?: number
          created_at?: string
          edited_at?: string | null
          edited_by_user?: boolean
          id?: string
          job_id?: string
          source?: string
          time_seconds?: number
          x_pixels?: number
        }
        Relationships: [
          {
            foreignKeyName: 'playhub_crop_keyframes_job_id_fkey'
            columns: ['job_id']
            isOneToOne: false
            referencedRelation: 'playhub_crop_jobs'
            referencedColumns: ['id']
          },
        ]
      }
      playhub_deleted_spiideo_games: {
        Row: {
          deleted_at: string
          deleted_by: string | null
          spiideo_game_id: string
        }
        Insert: {
          deleted_at?: string
          deleted_by?: string | null
          spiideo_game_id: string
        }
        Update: {
          deleted_at?: string
          deleted_by?: string | null
          spiideo_game_id?: string
        }
        Relationships: []
      }
      playhub_feature_flags: {
        Row: {
          enabled: boolean
          key: string
          notes: string | null
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          enabled?: boolean
          key: string
          notes?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          enabled?: boolean
          key?: string
          notes?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      playhub_graphic_packages: {
        Row: {
          created_at: string | null
          id: string
          is_default: boolean | null
          logo_position: string | null
          logo_scale: number | null
          logo_url: string | null
          logo_x: number | null
          logo_y: number | null
          name: string
          organization_id: string
          spiideo_graphic_package_id: string | null
          sponsor_logo_url: string | null
          sponsor_position: string | null
          sponsor_scale: number | null
          sponsor_x: number | null
          sponsor_y: number | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          id?: string
          is_default?: boolean | null
          logo_position?: string | null
          logo_scale?: number | null
          logo_url?: string | null
          logo_x?: number | null
          logo_y?: number | null
          name: string
          organization_id: string
          spiideo_graphic_package_id?: string | null
          sponsor_logo_url?: string | null
          sponsor_position?: string | null
          sponsor_scale?: number | null
          sponsor_x?: number | null
          sponsor_y?: number | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          id?: string
          is_default?: boolean | null
          logo_position?: string | null
          logo_scale?: number | null
          logo_url?: string | null
          logo_x?: number | null
          logo_y?: number | null
          name?: string
          organization_id?: string
          spiideo_graphic_package_id?: string | null
          sponsor_logo_url?: string | null
          sponsor_position?: string | null
          sponsor_scale?: number | null
          sponsor_x?: number | null
          sponsor_y?: number | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'playhub_graphic_packages_organization_id_fkey'
            columns: ['organization_id']
            isOneToOne: false
            referencedRelation: 'organizations'
            referencedColumns: ['id']
          },
        ]
      }
      playhub_group_tier_config: {
        Row: {
          created_at: string
          football_camera_count: number
          group_organization_id: string
          id: string
          padel_camera_count: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          football_camera_count?: number
          group_organization_id: string
          id?: string
          padel_camera_count?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          football_camera_count?: number
          group_organization_id?: string
          id?: string
          padel_camera_count?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'playhub_group_tier_config_group_organization_id_fkey'
            columns: ['group_organization_id']
            isOneToOne: true
            referencedRelation: 'organizations'
            referencedColumns: ['id']
          },
        ]
      }
      playhub_invoice_line_items: {
        Row: {
          ambassador_fee: number | null
          billable_amount: number
          collected_by: string
          created_at: string
          currency: string
          duration_seconds: number
          fixed_cost_eur_per_hour: number | null
          fixed_cost_local: number | null
          fx_rate: number | null
          gross_amount: number | null
          id: string
          invoice_id: string
          partner_share: number | null
          partner_share_pct: number | null
          playback_share: number | null
          recording_id: string | null
          recording_match_date: string | null
          recording_title: string | null
          sport: string | null
        }
        Insert: {
          ambassador_fee?: number | null
          billable_amount: number
          collected_by: string
          created_at?: string
          currency: string
          duration_seconds: number
          fixed_cost_eur_per_hour?: number | null
          fixed_cost_local?: number | null
          fx_rate?: number | null
          gross_amount?: number | null
          id?: string
          invoice_id: string
          partner_share?: number | null
          partner_share_pct?: number | null
          playback_share?: number | null
          recording_id?: string | null
          recording_match_date?: string | null
          recording_title?: string | null
          sport?: string | null
        }
        Update: {
          ambassador_fee?: number | null
          billable_amount?: number
          collected_by?: string
          created_at?: string
          currency?: string
          duration_seconds?: number
          fixed_cost_eur_per_hour?: number | null
          fixed_cost_local?: number | null
          fx_rate?: number | null
          gross_amount?: number | null
          id?: string
          invoice_id?: string
          partner_share?: number | null
          partner_share_pct?: number | null
          playback_share?: number | null
          recording_id?: string | null
          recording_match_date?: string | null
          recording_title?: string | null
          sport?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'playhub_invoice_line_items_invoice_id_fkey'
            columns: ['invoice_id']
            isOneToOne: false
            referencedRelation: 'playhub_venue_invoices'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'playhub_invoice_line_items_recording_id_fkey'
            columns: ['recording_id']
            isOneToOne: false
            referencedRelation: 'playhub_match_recordings'
            referencedColumns: ['id']
          },
        ]
      }
      playhub_live_streams: {
        Row: {
          access_type: string
          actual_end: string | null
          actual_start: string | null
          away_team: string | null
          cloudfront_distribution_id: string | null
          competition: string | null
          created_at: string | null
          created_by: string | null
          currency: string | null
          description: string | null
          enable_recording: boolean | null
          home_team: string | null
          id: string
          is_unlocked: boolean | null
          medialive_channel_id: string | null
          medialive_input_id: string | null
          mediapackage_channel_id: string | null
          mediapackage_endpoint_id: string | null
          organization_id: string | null
          playback_url: string | null
          price_amount: number | null
          recording_id: string | null
          recording_s3_bucket: string | null
          recording_s3_prefix: string | null
          rtmp_stream_key: string | null
          rtmp_url: string | null
          scheduled_end: string | null
          scheduled_start: string
          spiideo_game_id: string | null
          sport_id: string | null
          status: string | null
          stripe_price_id: string | null
          stripe_product_id: string | null
          thumbnail_url: string | null
          title: string
          unlocked_at: string | null
          unlocked_by: string | null
          updated_at: string | null
          venue: string | null
        }
        Insert: {
          access_type?: string
          actual_end?: string | null
          actual_start?: string | null
          away_team?: string | null
          cloudfront_distribution_id?: string | null
          competition?: string | null
          created_at?: string | null
          created_by?: string | null
          currency?: string | null
          description?: string | null
          enable_recording?: boolean | null
          home_team?: string | null
          id?: string
          is_unlocked?: boolean | null
          medialive_channel_id?: string | null
          medialive_input_id?: string | null
          mediapackage_channel_id?: string | null
          mediapackage_endpoint_id?: string | null
          organization_id?: string | null
          playback_url?: string | null
          price_amount?: number | null
          recording_id?: string | null
          recording_s3_bucket?: string | null
          recording_s3_prefix?: string | null
          rtmp_stream_key?: string | null
          rtmp_url?: string | null
          scheduled_end?: string | null
          scheduled_start: string
          spiideo_game_id?: string | null
          sport_id?: string | null
          status?: string | null
          stripe_price_id?: string | null
          stripe_product_id?: string | null
          thumbnail_url?: string | null
          title: string
          unlocked_at?: string | null
          unlocked_by?: string | null
          updated_at?: string | null
          venue?: string | null
        }
        Update: {
          access_type?: string
          actual_end?: string | null
          actual_start?: string | null
          away_team?: string | null
          cloudfront_distribution_id?: string | null
          competition?: string | null
          created_at?: string | null
          created_by?: string | null
          currency?: string | null
          description?: string | null
          enable_recording?: boolean | null
          home_team?: string | null
          id?: string
          is_unlocked?: boolean | null
          medialive_channel_id?: string | null
          medialive_input_id?: string | null
          mediapackage_channel_id?: string | null
          mediapackage_endpoint_id?: string | null
          organization_id?: string | null
          playback_url?: string | null
          price_amount?: number | null
          recording_id?: string | null
          recording_s3_bucket?: string | null
          recording_s3_prefix?: string | null
          rtmp_stream_key?: string | null
          rtmp_url?: string | null
          scheduled_end?: string | null
          scheduled_start?: string
          spiideo_game_id?: string | null
          sport_id?: string | null
          status?: string | null
          stripe_price_id?: string | null
          stripe_product_id?: string | null
          thumbnail_url?: string | null
          title?: string
          unlocked_at?: string | null
          unlocked_by?: string | null
          updated_at?: string | null
          venue?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'playhub_live_streams_organization_id_fkey'
            columns: ['organization_id']
            isOneToOne: false
            referencedRelation: 'organizations'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'playhub_live_streams_sport_id_fkey'
            columns: ['sport_id']
            isOneToOne: false
            referencedRelation: 'sports'
            referencedColumns: ['id']
          },
        ]
      }
      playhub_match_recordings: {
        Row: {
          access_method: string | null
          access_type: string | null
          aim_track_attempts: number | null
          aim_track_error: string | null
          aim_track_started_at: string | null
          aim_track_status: string | null
          away_team: string
          billable_amount: number | null
          billable_currency: string | null
          clutch_device_id: string | null
          clutch_match_stats: Json | null
          clutch_video_id: string | null
          collected_by: string | null
          competition: string | null
          content_type: string | null
          created_at: string | null
          created_by: string | null
          currency: string | null
          description: string | null
          duration_seconds: number | null
          external_provider_id: string | null
          external_url: string | null
          file_size_bytes: number | null
          graphic_package_id: string | null
          home_team: string
          id: string
          is_billable: boolean | null
          last_sync_error: string | null
          marketplace_enabled: boolean | null
          match_date: string
          organization_id: string | null
          panorama_capture_attempts: number | null
          panorama_capture_error: string | null
          panorama_capture_started_at: string | null
          panorama_capture_status: string | null
          panorama_s3_key: string | null
          pitch_focus: string
          pitch_name: string | null
          preview_url: string | null
          price_amount: number | null
          published_at: string | null
          s3_bucket: string | null
          s3_key: string | null
          share_token: string | null
          spiideo_game_id: string | null
          spiideo_production_id: string | null
          spiideo_scene_id: string | null
          sport_id: string | null
          status: string | null
          stripe_payment_intent_id: string | null
          stripe_price_id: string | null
          stripe_product_id: string | null
          sync_attempts: number | null
          thumbnail_url: string | null
          title: string
          tracklets_attempts: number | null
          tracklets_error: string | null
          tracklets_started_at: string | null
          tracklets_status: string | null
          transferred_at: string | null
          updated_at: string | null
          venue: string | null
          venue_organization_id: string
          video_url: string | null
        }
        Insert: {
          access_method?: string | null
          access_type?: string | null
          aim_track_attempts?: number | null
          aim_track_error?: string | null
          aim_track_started_at?: string | null
          aim_track_status?: string | null
          away_team: string
          billable_amount?: number | null
          billable_currency?: string | null
          clutch_device_id?: string | null
          clutch_match_stats?: Json | null
          clutch_video_id?: string | null
          collected_by?: string | null
          competition?: string | null
          content_type?: string | null
          created_at?: string | null
          created_by?: string | null
          currency?: string | null
          description?: string | null
          duration_seconds?: number | null
          external_provider_id?: string | null
          external_url?: string | null
          file_size_bytes?: number | null
          graphic_package_id?: string | null
          home_team: string
          id?: string
          is_billable?: boolean | null
          last_sync_error?: string | null
          marketplace_enabled?: boolean | null
          match_date: string
          organization_id?: string | null
          panorama_capture_attempts?: number | null
          panorama_capture_error?: string | null
          panorama_capture_started_at?: string | null
          panorama_capture_status?: string | null
          panorama_s3_key?: string | null
          pitch_focus?: string
          pitch_name?: string | null
          preview_url?: string | null
          price_amount?: number | null
          published_at?: string | null
          s3_bucket?: string | null
          s3_key?: string | null
          share_token?: string | null
          spiideo_game_id?: string | null
          spiideo_production_id?: string | null
          spiideo_scene_id?: string | null
          sport_id?: string | null
          status?: string | null
          stripe_payment_intent_id?: string | null
          stripe_price_id?: string | null
          stripe_product_id?: string | null
          sync_attempts?: number | null
          thumbnail_url?: string | null
          title: string
          tracklets_attempts?: number | null
          tracklets_error?: string | null
          tracklets_started_at?: string | null
          tracklets_status?: string | null
          transferred_at?: string | null
          updated_at?: string | null
          venue?: string | null
          venue_organization_id: string
          video_url?: string | null
        }
        Update: {
          access_method?: string | null
          access_type?: string | null
          aim_track_attempts?: number | null
          aim_track_error?: string | null
          aim_track_started_at?: string | null
          aim_track_status?: string | null
          away_team?: string
          billable_amount?: number | null
          billable_currency?: string | null
          clutch_device_id?: string | null
          clutch_match_stats?: Json | null
          clutch_video_id?: string | null
          collected_by?: string | null
          competition?: string | null
          content_type?: string | null
          created_at?: string | null
          created_by?: string | null
          currency?: string | null
          description?: string | null
          duration_seconds?: number | null
          external_provider_id?: string | null
          external_url?: string | null
          file_size_bytes?: number | null
          graphic_package_id?: string | null
          home_team?: string
          id?: string
          is_billable?: boolean | null
          last_sync_error?: string | null
          marketplace_enabled?: boolean | null
          match_date?: string
          organization_id?: string | null
          panorama_capture_attempts?: number | null
          panorama_capture_error?: string | null
          panorama_capture_started_at?: string | null
          panorama_capture_status?: string | null
          panorama_s3_key?: string | null
          pitch_focus?: string
          pitch_name?: string | null
          preview_url?: string | null
          price_amount?: number | null
          published_at?: string | null
          s3_bucket?: string | null
          s3_key?: string | null
          share_token?: string | null
          spiideo_game_id?: string | null
          spiideo_production_id?: string | null
          spiideo_scene_id?: string | null
          sport_id?: string | null
          status?: string | null
          stripe_payment_intent_id?: string | null
          stripe_price_id?: string | null
          stripe_product_id?: string | null
          sync_attempts?: number | null
          thumbnail_url?: string | null
          title?: string
          tracklets_attempts?: number | null
          tracklets_error?: string | null
          tracklets_started_at?: string | null
          tracklets_status?: string | null
          transferred_at?: string | null
          updated_at?: string | null
          venue?: string | null
          venue_organization_id?: string
          video_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'playhub_match_recordings_graphic_package_id_fkey'
            columns: ['graphic_package_id']
            isOneToOne: false
            referencedRelation: 'playhub_graphic_packages'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'playhub_match_recordings_organization_id_fkey'
            columns: ['organization_id']
            isOneToOne: false
            referencedRelation: 'organizations'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'playhub_match_recordings_sport_id_fkey'
            columns: ['sport_id']
            isOneToOne: false
            referencedRelation: 'sports'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'playhub_match_recordings_venue_organization_id_fkey'
            columns: ['venue_organization_id']
            isOneToOne: false
            referencedRelation: 'organizations'
            referencedColumns: ['id']
          },
        ]
      }
      playhub_music_beds: {
        Row: {
          bpm: number | null
          created_at: string
          duration_seconds: number
          genre: string | null
          id: string
          intensity: number | null
          is_active: boolean
          license_ref: string | null
          mood: string | null
          mubert_track_id: string | null
          source: string
          storage_path: string
          title: string
          updated_at: string
        }
        Insert: {
          bpm?: number | null
          created_at?: string
          duration_seconds: number
          genre?: string | null
          id?: string
          intensity?: number | null
          is_active?: boolean
          license_ref?: string | null
          mood?: string | null
          mubert_track_id?: string | null
          source?: string
          storage_path: string
          title: string
          updated_at?: string
        }
        Update: {
          bpm?: number | null
          created_at?: string
          duration_seconds?: number
          genre?: string | null
          id?: string
          intensity?: number | null
          is_active?: boolean
          license_ref?: string | null
          mood?: string | null
          mubert_track_id?: string | null
          source?: string
          storage_path?: string
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
      playhub_panorama_scene_meshes: {
        Row: {
          scene_id: string
          source_game_id: string
          updated_at: string
        }
        Insert: {
          scene_id: string
          source_game_id: string
          updated_at?: string
        }
        Update: {
          scene_id?: string
          source_game_id?: string
          updated_at?: string
        }
        Relationships: []
      }
      playhub_pending_academy_subscriptions: {
        Row: {
          claimed_at: string | null
          claimed_user_id: string | null
          club_slug: string
          customer_name: string | null
          id: string
          invited_at: string
          invited_email: string
          last_known_status: string
          player_name: string | null
          registration_subclub: string | null
          registration_team: string | null
          stripe_customer_id: string
          stripe_subscription_id: string
          subscriber_type: string | null
        }
        Insert: {
          claimed_at?: string | null
          claimed_user_id?: string | null
          club_slug: string
          customer_name?: string | null
          id?: string
          invited_at?: string
          invited_email: string
          last_known_status: string
          player_name?: string | null
          registration_subclub?: string | null
          registration_team?: string | null
          stripe_customer_id: string
          stripe_subscription_id: string
          subscriber_type?: string | null
        }
        Update: {
          claimed_at?: string | null
          claimed_user_id?: string | null
          club_slug?: string
          customer_name?: string | null
          id?: string
          invited_at?: string
          invited_email?: string
          last_known_status?: string
          player_name?: string | null
          registration_subclub?: string | null
          registration_team?: string | null
          stripe_customer_id?: string
          stripe_subscription_id?: string
          subscriber_type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'playhub_pending_academy_subscriptions_club_slug_fkey'
            columns: ['club_slug']
            isOneToOne: false
            referencedRelation: 'playhub_academy_config'
            referencedColumns: ['club_slug']
          },
        ]
      }
      playhub_pending_admin_invites: {
        Row: {
          id: string
          invited_at: string | null
          invited_by: string | null
          invited_email: string
          organization_id: string
          role: string
        }
        Insert: {
          id?: string
          invited_at?: string | null
          invited_by?: string | null
          invited_email: string
          organization_id: string
          role?: string
        }
        Update: {
          id?: string
          invited_at?: string | null
          invited_by?: string | null
          invited_email?: string
          organization_id?: string
          role?: string
        }
        Relationships: [
          {
            foreignKeyName: 'playhub_pending_admin_invites_organization_id_fkey'
            columns: ['organization_id']
            isOneToOne: false
            referencedRelation: 'organizations'
            referencedColumns: ['id']
          },
        ]
      }
      playhub_pitch_calibrations: {
        Row: {
          created_at: string
          created_by: string | null
          field_polygon_rayn: Json | null
          frame_height: number
          frame_s3_key: string
          frame_width: number
          homography: Json | null
          id: string
          marks: Json
          mesh_source_game_id: string | null
          pitch_length_m: number
          pitch_width_m: number
          provider: string
          reprojection_error_px: number | null
          scene_id: string
          solver_version: number | null
          source: string
          status: string
          superseded_at: string | null
          superseded_by: string | null
          venue_organization_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          field_polygon_rayn?: Json | null
          frame_height?: number
          frame_s3_key: string
          frame_width?: number
          homography?: Json | null
          id?: string
          marks: Json
          mesh_source_game_id?: string | null
          pitch_length_m: number
          pitch_width_m: number
          provider: string
          reprojection_error_px?: number | null
          scene_id: string
          solver_version?: number | null
          source?: string
          status?: string
          superseded_at?: string | null
          superseded_by?: string | null
          venue_organization_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          field_polygon_rayn?: Json | null
          frame_height?: number
          frame_s3_key?: string
          frame_width?: number
          homography?: Json | null
          id?: string
          marks?: Json
          mesh_source_game_id?: string | null
          pitch_length_m?: number
          pitch_width_m?: number
          provider?: string
          reprojection_error_px?: number | null
          scene_id?: string
          solver_version?: number | null
          source?: string
          status?: string
          superseded_at?: string | null
          superseded_by?: string | null
          venue_organization_id?: string
        }
        Relationships: [
          {
            foreignKeyName: 'playhub_pitch_calibrations_scene_id_fkey'
            columns: ['scene_id']
            isOneToOne: false
            referencedRelation: 'playhub_scene_venue_mapping'
            referencedColumns: ['scene_id']
          },
          {
            foreignKeyName: 'playhub_pitch_calibrations_superseded_by_fkey'
            columns: ['superseded_by']
            isOneToOne: false
            referencedRelation: 'playhub_pitch_calibrations'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'playhub_pitch_calibrations_venue_organization_id_fkey'
            columns: ['venue_organization_id']
            isOneToOne: false
            referencedRelation: 'organizations'
            referencedColumns: ['id']
          },
        ]
      }
      playhub_portrait_renders: {
        Row: {
          attempts: number
          club_slug: string
          created_at: string
          error: string | null
          id: string
          provider_event_id: string
          provider_recording_id: string
          published_at: string | null
          published_by: string | null
          quality: Json | null
          recording_event_id: string
          status: string
          storage_path: string
          updated_at: string
        }
        Insert: {
          attempts?: number
          club_slug: string
          created_at?: string
          error?: string | null
          id?: string
          provider_event_id: string
          provider_recording_id: string
          published_at?: string | null
          published_by?: string | null
          quality?: Json | null
          recording_event_id: string
          status?: string
          storage_path: string
          updated_at?: string
        }
        Update: {
          attempts?: number
          club_slug?: string
          created_at?: string
          error?: string | null
          id?: string
          provider_event_id?: string
          provider_recording_id?: string
          published_at?: string | null
          published_by?: string | null
          quality?: Json | null
          recording_event_id?: string
          status?: string
          storage_path?: string
          updated_at?: string
        }
        Relationships: []
      }
      playhub_products: {
        Row: {
          access_duration_days: number | null
          available_from: string | null
          available_until: string | null
          created_at: string | null
          currency: string | null
          description: string | null
          id: string
          is_available: boolean | null
          match_recording_id: string | null
          name: string
          price_amount: number
          stripe_price_id: string | null
          stripe_product_id: string | null
          updated_at: string | null
        }
        Insert: {
          access_duration_days?: number | null
          available_from?: string | null
          available_until?: string | null
          created_at?: string | null
          currency?: string | null
          description?: string | null
          id?: string
          is_available?: boolean | null
          match_recording_id?: string | null
          name: string
          price_amount: number
          stripe_price_id?: string | null
          stripe_product_id?: string | null
          updated_at?: string | null
        }
        Update: {
          access_duration_days?: number | null
          available_from?: string | null
          available_until?: string | null
          created_at?: string | null
          currency?: string | null
          description?: string | null
          id?: string
          is_available?: boolean | null
          match_recording_id?: string | null
          name?: string
          price_amount?: number
          stripe_price_id?: string | null
          stripe_product_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'playhub_products_match_recording_id_fkey'
            columns: ['match_recording_id']
            isOneToOne: false
            referencedRelation: 'playhub_match_recordings'
            referencedColumns: ['id']
          },
        ]
      }
      playhub_purchases: {
        Row: {
          amount_paid: number
          completed_at: string | null
          currency: string | null
          customer_email: string | null
          customer_name: string | null
          id: string
          match_recording_id: string | null
          organization_id: string | null
          product_id: string | null
          profile_id: string | null
          purchased_at: string | null
          refunded_at: string | null
          status: string | null
          stripe_checkout_session_id: string | null
          stripe_payment_intent_id: string | null
          user_id: string | null
        }
        Insert: {
          amount_paid: number
          completed_at?: string | null
          currency?: string | null
          customer_email?: string | null
          customer_name?: string | null
          id?: string
          match_recording_id?: string | null
          organization_id?: string | null
          product_id?: string | null
          profile_id?: string | null
          purchased_at?: string | null
          refunded_at?: string | null
          status?: string | null
          stripe_checkout_session_id?: string | null
          stripe_payment_intent_id?: string | null
          user_id?: string | null
        }
        Update: {
          amount_paid?: number
          completed_at?: string | null
          currency?: string | null
          customer_email?: string | null
          customer_name?: string | null
          id?: string
          match_recording_id?: string | null
          organization_id?: string | null
          product_id?: string | null
          profile_id?: string | null
          purchased_at?: string | null
          refunded_at?: string | null
          status?: string | null
          stripe_checkout_session_id?: string | null
          stripe_payment_intent_id?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'playhub_purchases_match_recording_id_fkey'
            columns: ['match_recording_id']
            isOneToOne: false
            referencedRelation: 'playhub_match_recordings'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'playhub_purchases_organization_id_fkey'
            columns: ['organization_id']
            isOneToOne: false
            referencedRelation: 'organizations'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'playhub_purchases_product_id_fkey'
            columns: ['product_id']
            isOneToOne: false
            referencedRelation: 'playhub_products'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'playhub_purchases_profile_id_fkey'
            columns: ['profile_id']
            isOneToOne: false
            referencedRelation: 'profiles'
            referencedColumns: ['id']
          },
        ]
      }
      playhub_recording_assignments: {
        Row: {
          away_accepted_recording_uuid: string | null
          away_assigned_at: string | null
          away_share_key: string | null
          away_team_slug: string | null
          away_team_uuid: string | null
          created_at: string
          duration_seconds: number | null
          failure_stage: string | null
          home_assigned_at: string | null
          home_team_slug: string | null
          home_team_uuid: string | null
          id: string
          last_error: string | null
          last_processed_at: string | null
          last_sync_run_id: string | null
          league_club_slug: string
          llm_attempted_at: string | null
          match_date: string | null
          parse_confidence: number | null
          parse_method: string | null
          parse_reasoning: string | null
          parsed_away_age_group: string | null
          parsed_away_subclub_slug: string | null
          parsed_home_age_group: string | null
          parsed_home_subclub_slug: string | null
          recording_slug: string
          recording_title: string
          recording_uuid: string
          status: string
          updated_at: string
        }
        Insert: {
          away_accepted_recording_uuid?: string | null
          away_assigned_at?: string | null
          away_share_key?: string | null
          away_team_slug?: string | null
          away_team_uuid?: string | null
          created_at?: string
          duration_seconds?: number | null
          failure_stage?: string | null
          home_assigned_at?: string | null
          home_team_slug?: string | null
          home_team_uuid?: string | null
          id?: string
          last_error?: string | null
          last_processed_at?: string | null
          last_sync_run_id?: string | null
          league_club_slug: string
          llm_attempted_at?: string | null
          match_date?: string | null
          parse_confidence?: number | null
          parse_method?: string | null
          parse_reasoning?: string | null
          parsed_away_age_group?: string | null
          parsed_away_subclub_slug?: string | null
          parsed_home_age_group?: string | null
          parsed_home_subclub_slug?: string | null
          recording_slug: string
          recording_title: string
          recording_uuid: string
          status: string
          updated_at?: string
        }
        Update: {
          away_accepted_recording_uuid?: string | null
          away_assigned_at?: string | null
          away_share_key?: string | null
          away_team_slug?: string | null
          away_team_uuid?: string | null
          created_at?: string
          duration_seconds?: number | null
          failure_stage?: string | null
          home_assigned_at?: string | null
          home_team_slug?: string | null
          home_team_uuid?: string | null
          id?: string
          last_error?: string | null
          last_processed_at?: string | null
          last_sync_run_id?: string | null
          league_club_slug?: string
          llm_attempted_at?: string | null
          match_date?: string | null
          parse_confidence?: number | null
          parse_method?: string | null
          parse_reasoning?: string | null
          parsed_away_age_group?: string | null
          parsed_away_subclub_slug?: string | null
          parsed_home_age_group?: string | null
          parsed_home_subclub_slug?: string | null
          recording_slug?: string
          recording_title?: string
          recording_uuid?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'playhub_recording_assignments_league_club_slug_fkey'
            columns: ['league_club_slug']
            isOneToOne: false
            referencedRelation: 'playhub_academy_config'
            referencedColumns: ['club_slug']
          },
        ]
      }
      playhub_recording_events: {
        Row: {
          confidence_score: number | null
          created_at: string | null
          created_by: string | null
          event_type: string
          id: string
          label: string | null
          match_recording_id: string | null
          provider: string | null
          provider_event_id: string | null
          provider_recording_id: string | null
          source: string
          team: string | null
          timestamp_seconds: number
          updated_at: string | null
          visibility: string
        }
        Insert: {
          confidence_score?: number | null
          created_at?: string | null
          created_by?: string | null
          event_type: string
          id?: string
          label?: string | null
          match_recording_id?: string | null
          provider?: string | null
          provider_event_id?: string | null
          provider_recording_id?: string | null
          source?: string
          team?: string | null
          timestamp_seconds: number
          updated_at?: string | null
          visibility?: string
        }
        Update: {
          confidence_score?: number | null
          created_at?: string | null
          created_by?: string | null
          event_type?: string
          id?: string
          label?: string | null
          match_recording_id?: string | null
          provider?: string | null
          provider_event_id?: string | null
          provider_recording_id?: string | null
          source?: string
          team?: string | null
          timestamp_seconds?: number
          updated_at?: string | null
          visibility?: string
        }
        Relationships: [
          {
            foreignKeyName: 'playhub_recording_events_match_recording_id_fkey'
            columns: ['match_recording_id']
            isOneToOne: false
            referencedRelation: 'playhub_match_recordings'
            referencedColumns: ['id']
          },
        ]
      }
      playhub_recording_sync_runs: {
        Row: {
          auto_corrections: number | null
          completed_at: string | null
          created_by: string | null
          errors_jsonb: Json | null
          failures: number | null
          home_assignments: number | null
          id: string
          league_club_slug: string
          llm_cost_usd: number | null
          llm_parsed: number | null
          llm_total_input_tokens: number | null
          llm_total_output_tokens: number | null
          new_recordings: number | null
          rules_parsed: number | null
          share_accepts: number | null
          started_at: string
          status: string
          trigger_source: string
          unparseable: number | null
          veo_recordings_seen: number | null
        }
        Insert: {
          auto_corrections?: number | null
          completed_at?: string | null
          created_by?: string | null
          errors_jsonb?: Json | null
          failures?: number | null
          home_assignments?: number | null
          id?: string
          league_club_slug: string
          llm_cost_usd?: number | null
          llm_parsed?: number | null
          llm_total_input_tokens?: number | null
          llm_total_output_tokens?: number | null
          new_recordings?: number | null
          rules_parsed?: number | null
          share_accepts?: number | null
          started_at?: string
          status: string
          trigger_source: string
          unparseable?: number | null
          veo_recordings_seen?: number | null
        }
        Update: {
          auto_corrections?: number | null
          completed_at?: string | null
          created_by?: string | null
          errors_jsonb?: Json | null
          failures?: number | null
          home_assignments?: number | null
          id?: string
          league_club_slug?: string
          llm_cost_usd?: number | null
          llm_parsed?: number | null
          llm_total_input_tokens?: number | null
          llm_total_output_tokens?: number | null
          new_recordings?: number | null
          rules_parsed?: number | null
          share_accepts?: number | null
          started_at?: string
          status?: string
          trigger_source?: string
          unparseable?: number | null
          veo_recordings_seen?: number | null
        }
        Relationships: [
          {
            foreignKeyName: 'playhub_recording_sync_runs_league_club_slug_fkey'
            columns: ['league_club_slug']
            isOneToOne: false
            referencedRelation: 'playhub_academy_config'
            referencedColumns: ['club_slug']
          },
        ]
      }
      playhub_scene_venue_mapping: {
        Row: {
          created_at: string | null
          organization_id: string | null
          provider: string
          scene_id: string
          scene_name: string | null
        }
        Insert: {
          created_at?: string | null
          organization_id?: string | null
          provider?: string
          scene_id: string
          scene_name?: string | null
        }
        Update: {
          created_at?: string | null
          organization_id?: string | null
          provider?: string
          scene_id?: string
          scene_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'playhub_scene_venue_mapping_organization_id_fkey'
            columns: ['organization_id']
            isOneToOne: false
            referencedRelation: 'organizations'
            referencedColumns: ['id']
          },
        ]
      }
      playhub_spiideo_scene_health: {
        Row: {
          account_id: string | null
          alert_state: string | null
          available_for_recording: boolean | null
          camera_count: number | null
          created_at: string
          last_checked_at: string
          last_online_change: string | null
          last_snapshot_at: string | null
          last_snapshot_error: string | null
          last_snapshot_status: string | null
          online: boolean | null
          online_cameras: number | null
          organization_id: string | null
          outages: number | null
          scene_id: string
          scene_name: string | null
          status_raw: Json | null
          updated_at: string
        }
        Insert: {
          account_id?: string | null
          alert_state?: string | null
          available_for_recording?: boolean | null
          camera_count?: number | null
          created_at?: string
          last_checked_at?: string
          last_online_change?: string | null
          last_snapshot_at?: string | null
          last_snapshot_error?: string | null
          last_snapshot_status?: string | null
          online?: boolean | null
          online_cameras?: number | null
          organization_id?: string | null
          outages?: number | null
          scene_id: string
          scene_name?: string | null
          status_raw?: Json | null
          updated_at?: string
        }
        Update: {
          account_id?: string | null
          alert_state?: string | null
          available_for_recording?: boolean | null
          camera_count?: number | null
          created_at?: string
          last_checked_at?: string
          last_online_change?: string | null
          last_snapshot_at?: string | null
          last_snapshot_error?: string | null
          last_snapshot_status?: string | null
          online?: boolean | null
          online_cameras?: number | null
          organization_id?: string | null
          outages?: number | null
          scene_id?: string
          scene_name?: string | null
          status_raw?: Json | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'playhub_spiideo_scene_health_organization_id_fkey'
            columns: ['organization_id']
            isOneToOne: false
            referencedRelation: 'organizations'
            referencedColumns: ['id']
          },
        ]
      }
      playhub_stream_access: {
        Row: {
          access_source: string
          amount_paid: number | null
          expires_at: string | null
          granted_at: string | null
          id: string
          is_active: boolean | null
          stream_id: string
          stripe_payment_intent_id: string | null
          user_id: string
        }
        Insert: {
          access_source: string
          amount_paid?: number | null
          expires_at?: string | null
          granted_at?: string | null
          id?: string
          is_active?: boolean | null
          stream_id: string
          stripe_payment_intent_id?: string | null
          user_id: string
        }
        Update: {
          access_source?: string
          amount_paid?: number | null
          expires_at?: string | null
          granted_at?: string | null
          id?: string
          is_active?: boolean | null
          stream_id?: string
          stripe_payment_intent_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: 'playhub_stream_access_stream_id_fkey'
            columns: ['stream_id']
            isOneToOne: false
            referencedRelation: 'playhub_live_streams'
            referencedColumns: ['id']
          },
        ]
      }
      playhub_venue_billing_config: {
        Row: {
          ambassador_pct: number | null
          billing_model: string | null
          booking_durations: number[] | null
          booking_enabled: boolean | null
          created_at: string | null
          currency: string | null
          daily_recording_target: number | null
          default_billable_amount: number | null
          default_price_amount: number | null
          default_price_currency: string | null
          fixed_cost_eur: number | null
          fixed_cost_per_recording: number | null
          id: string
          is_active: boolean | null
          marketplace_enabled: boolean | null
          marketplace_revenue_split_pct: number | null
          media_pack: Json | null
          organization_id: string
          stripe_customer_id: string | null
          updated_at: string | null
          venue_profit_share_pct: number | null
        }
        Insert: {
          ambassador_pct?: number | null
          billing_model?: string | null
          booking_durations?: number[] | null
          booking_enabled?: boolean | null
          created_at?: string | null
          currency?: string | null
          daily_recording_target?: number | null
          default_billable_amount?: number | null
          default_price_amount?: number | null
          default_price_currency?: string | null
          fixed_cost_eur?: number | null
          fixed_cost_per_recording?: number | null
          id?: string
          is_active?: boolean | null
          marketplace_enabled?: boolean | null
          marketplace_revenue_split_pct?: number | null
          media_pack?: Json | null
          organization_id: string
          stripe_customer_id?: string | null
          updated_at?: string | null
          venue_profit_share_pct?: number | null
        }
        Update: {
          ambassador_pct?: number | null
          billing_model?: string | null
          booking_durations?: number[] | null
          booking_enabled?: boolean | null
          created_at?: string | null
          currency?: string | null
          daily_recording_target?: number | null
          default_billable_amount?: number | null
          default_price_amount?: number | null
          default_price_currency?: string | null
          fixed_cost_eur?: number | null
          fixed_cost_per_recording?: number | null
          id?: string
          is_active?: boolean | null
          marketplace_enabled?: boolean | null
          marketplace_revenue_split_pct?: number | null
          media_pack?: Json | null
          organization_id?: string
          stripe_customer_id?: string | null
          updated_at?: string | null
          venue_profit_share_pct?: number | null
        }
        Relationships: [
          {
            foreignKeyName: 'playhub_venue_billing_config_organization_id_fkey'
            columns: ['organization_id']
            isOneToOne: true
            referencedRelation: 'organizations'
            referencedColumns: ['id']
          },
        ]
      }
      playhub_venue_invoices: {
        Row: {
          created_at: string | null
          currency: string | null
          id: string
          line_items_count: number | null
          organization_id: string
          period_end: string
          period_start: string
          status: string | null
          stripe_invoice_id: string | null
          total_amount: number
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          currency?: string | null
          id?: string
          line_items_count?: number | null
          organization_id: string
          period_end: string
          period_start: string
          status?: string | null
          stripe_invoice_id?: string | null
          total_amount?: number
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          currency?: string | null
          id?: string
          line_items_count?: number | null
          organization_id?: string
          period_end?: string
          period_start?: string
          status?: string | null
          stripe_invoice_id?: string | null
          total_amount?: number
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'playhub_venue_invoices_organization_id_fkey'
            columns: ['organization_id']
            isOneToOne: false
            referencedRelation: 'organizations'
            referencedColumns: ['id']
          },
        ]
      }
      playhub_veo_auth_tokens: {
        Row: {
          bearer_token: string
          captured_at: string
          created_by: string | null
          csrf_token: string
          expires_at: string
          id: string
        }
        Insert: {
          bearer_token: string
          captured_at?: string
          created_by?: string | null
          csrf_token: string
          expires_at?: string
          id?: string
        }
        Update: {
          bearer_token?: string
          captured_at?: string
          created_by?: string | null
          csrf_token?: string
          expires_at?: string
          id?: string
        }
        Relationships: []
      }
      playhub_veo_captures: {
        Row: {
          capture_attempts: number
          capture_error: string | null
          capture_started_at: string | null
          capture_status: string | null
          created_at: string
          id: string
          match_date: string | null
          match_slug: string
          panorama_bytes: number | null
          panorama_s3_key: string | null
          tracking_s3_key: string | null
          veo_club_slug: string
        }
        Insert: {
          capture_attempts?: number
          capture_error?: string | null
          capture_started_at?: string | null
          capture_status?: string | null
          created_at?: string
          id?: string
          match_date?: string | null
          match_slug: string
          panorama_bytes?: number | null
          panorama_s3_key?: string | null
          tracking_s3_key?: string | null
          veo_club_slug: string
        }
        Update: {
          capture_attempts?: number
          capture_error?: string | null
          capture_started_at?: string | null
          capture_status?: string | null
          created_at?: string
          id?: string
          match_date?: string | null
          match_slug?: string
          panorama_bytes?: number | null
          panorama_s3_key?: string | null
          tracking_s3_key?: string | null
          veo_club_slug?: string
        }
        Relationships: []
      }
      playhub_veo_clubs: {
        Row: {
          club_slug: string
          created_at: string | null
          id: string
          last_synced_at: string | null
          name: string
          sync_error: string | null
          sync_status: string | null
          team_count: number | null
          updated_at: string | null
          veo_club_id: string | null
          veo_club_slug: string
        }
        Insert: {
          club_slug: string
          created_at?: string | null
          id?: string
          last_synced_at?: string | null
          name: string
          sync_error?: string | null
          sync_status?: string | null
          team_count?: number | null
          updated_at?: string | null
          veo_club_id?: string | null
          veo_club_slug: string
        }
        Update: {
          club_slug?: string
          created_at?: string | null
          id?: string
          last_synced_at?: string | null
          name?: string
          sync_error?: string | null
          sync_status?: string | null
          team_count?: number | null
          updated_at?: string | null
          veo_club_id?: string | null
          veo_club_slug?: string
        }
        Relationships: []
      }
      playhub_veo_exceptions: {
        Row: {
          added_by: string | null
          club_slug: string
          created_at: string | null
          email: string
          id: string
          reason: string | null
        }
        Insert: {
          added_by?: string | null
          club_slug: string
          created_at?: string | null
          email: string
          id?: string
          reason?: string | null
        }
        Update: {
          added_by?: string | null
          club_slug?: string
          created_at?: string | null
          email?: string
          id?: string
          reason?: string | null
        }
        Relationships: []
      }
      playhub_veo_match_content_cache: {
        Row: {
          highlights: Json | null
          id: string
          is_processing: boolean | null
          last_fetched_at: string | null
          match_slug: string
          stats: Json | null
          videos: Json | null
        }
        Insert: {
          highlights?: Json | null
          id?: string
          is_processing?: boolean | null
          last_fetched_at?: string | null
          match_slug: string
          stats?: Json | null
          videos?: Json | null
        }
        Update: {
          highlights?: Json | null
          id?: string
          is_processing?: boolean | null
          last_fetched_at?: string | null
          match_slug?: string
          stats?: Json | null
          videos?: Json | null
        }
        Relationships: []
      }
      playhub_veo_members: {
        Row: {
          created_at: string | null
          email: string | null
          first_seen_at: string | null
          id: string
          last_seen_at: string | null
          name: string | null
          permission_role: string | null
          status: string | null
          updated_at: string | null
          veo_club_slug: string
          veo_member_id: string
          veo_team_slug: string
        }
        Insert: {
          created_at?: string | null
          email?: string | null
          first_seen_at?: string | null
          id?: string
          last_seen_at?: string | null
          name?: string | null
          permission_role?: string | null
          status?: string | null
          updated_at?: string | null
          veo_club_slug: string
          veo_member_id: string
          veo_team_slug: string
        }
        Update: {
          created_at?: string | null
          email?: string | null
          first_seen_at?: string | null
          id?: string
          last_seen_at?: string | null
          name?: string | null
          permission_role?: string | null
          status?: string | null
          updated_at?: string | null
          veo_club_slug?: string
          veo_member_id?: string
          veo_team_slug?: string
        }
        Relationships: []
      }
      playhub_veo_recordings_cache: {
        Row: {
          away_score: number | null
          away_team: string | null
          camera: string | null
          club_slug: string
          duration: number | null
          home_score: number | null
          home_team: string | null
          id: string
          last_synced_at: string | null
          match_date: string | null
          match_slug: string
          privacy: string | null
          processing_status: string | null
          team: string | null
          thumbnail: string | null
          title: string | null
          uuid: string | null
          veo_club_slug: string
        }
        Insert: {
          away_score?: number | null
          away_team?: string | null
          camera?: string | null
          club_slug: string
          duration?: number | null
          home_score?: number | null
          home_team?: string | null
          id?: string
          last_synced_at?: string | null
          match_date?: string | null
          match_slug: string
          privacy?: string | null
          processing_status?: string | null
          team?: string | null
          thumbnail?: string | null
          title?: string | null
          uuid?: string | null
          veo_club_slug: string
        }
        Update: {
          away_score?: number | null
          away_team?: string | null
          camera?: string | null
          club_slug?: string
          duration?: number | null
          home_score?: number | null
          home_team?: string | null
          id?: string
          last_synced_at?: string | null
          match_date?: string | null
          match_slug?: string
          privacy?: string | null
          processing_status?: string | null
          team?: string | null
          thumbnail?: string | null
          title?: string | null
          uuid?: string | null
          veo_club_slug?: string
        }
        Relationships: []
      }
      playhub_veo_teams: {
        Row: {
          created_at: string | null
          id: string
          member_count: number | null
          name: string
          updated_at: string | null
          veo_club_slug: string
          veo_team_id: string | null
          veo_team_slug: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          member_count?: number | null
          name: string
          updated_at?: string | null
          veo_club_slug: string
          veo_team_id?: string | null
          veo_team_slug: string
        }
        Update: {
          created_at?: string | null
          id?: string
          member_count?: number | null
          name?: string
          updated_at?: string | null
          veo_club_slug?: string
          veo_team_id?: string | null
          veo_team_slug?: string
        }
        Relationships: [
          {
            foreignKeyName: 'playhub_veo_teams_veo_club_slug_fkey'
            columns: ['veo_club_slug']
            isOneToOne: false
            referencedRelation: 'playhub_veo_clubs'
            referencedColumns: ['veo_club_slug']
          },
        ]
      }
      playhub_view_history: {
        Row: {
          browser: string | null
          completed_at: string | null
          completion_percentage: number | null
          device_type: string | null
          id: string
          last_position_at: string | null
          match_recording_id: string | null
          session_id: string | null
          started_at: string | null
          total_duration_seconds: number | null
          user_id: string | null
          watched_duration_seconds: number | null
        }
        Insert: {
          browser?: string | null
          completed_at?: string | null
          completion_percentage?: number | null
          device_type?: string | null
          id?: string
          last_position_at?: string | null
          match_recording_id?: string | null
          session_id?: string | null
          started_at?: string | null
          total_duration_seconds?: number | null
          user_id?: string | null
          watched_duration_seconds?: number | null
        }
        Update: {
          browser?: string | null
          completed_at?: string | null
          completion_percentage?: number | null
          device_type?: string | null
          id?: string
          last_position_at?: string | null
          match_recording_id?: string | null
          session_id?: string | null
          started_at?: string | null
          total_duration_seconds?: number | null
          user_id?: string | null
          watched_duration_seconds?: number | null
        }
        Relationships: [
          {
            foreignKeyName: 'playhub_view_history_match_recording_id_fkey'
            columns: ['match_recording_id']
            isOneToOne: false
            referencedRelation: 'playhub_match_recordings'
            referencedColumns: ['id']
          },
        ]
      }
      playscanner_collection_log: {
        Row: {
          city: string
          collection_id: string
          created_at: string | null
          date: string
          error_message: string | null
          execution_time_ms: number | null
          id: string
          provider: string | null
          slots_collected: number | null
          status: string
          venues_processed: number | null
        }
        Insert: {
          city: string
          collection_id: string
          created_at?: string | null
          date: string
          error_message?: string | null
          execution_time_ms?: number | null
          id?: string
          provider?: string | null
          slots_collected?: number | null
          status: string
          venues_processed?: number | null
        }
        Update: {
          city?: string
          collection_id?: string
          created_at?: string | null
          date?: string
          error_message?: string | null
          execution_time_ms?: number | null
          id?: string
          provider?: string | null
          slots_collected?: number | null
          status?: string
          venues_processed?: number | null
        }
        Relationships: []
      }
      playscanner_conversions: {
        Row: {
          booking_url: string | null
          clicked_at: string | null
          commission_rate: number | null
          estimated_commission: number | null
          estimated_price: number | null
          id: string
          provider_name: string
          search_id: string | null
          session_id: string | null
          sport: string | null
          venue_location: string | null
          venue_name: string | null
        }
        Insert: {
          booking_url?: string | null
          clicked_at?: string | null
          commission_rate?: number | null
          estimated_commission?: number | null
          estimated_price?: number | null
          id?: string
          provider_name: string
          search_id?: string | null
          session_id?: string | null
          sport?: string | null
          venue_location?: string | null
          venue_name?: string | null
        }
        Update: {
          booking_url?: string | null
          clicked_at?: string | null
          commission_rate?: number | null
          estimated_commission?: number | null
          estimated_price?: number | null
          id?: string
          provider_name?: string
          search_id?: string | null
          session_id?: string | null
          sport?: string | null
          venue_location?: string | null
          venue_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'playscanner_conversions_search_id_fkey'
            columns: ['search_id']
            isOneToOne: false
            referencedRelation: 'playscanner_searches'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'playscanner_conversions_session_id_fkey'
            columns: ['session_id']
            isOneToOne: false
            referencedRelation: 'playscanner_sessions'
            referencedColumns: ['session_id']
          },
        ]
      }
      playscanner_openactive_slots: {
        Row: {
          booking_url: string | null
          court_name: string
          created_at: string | null
          currency: string | null
          date: string
          duration: number
          end_time: string
          id: string
          indoor: boolean | null
          listing_type: string | null
          price: number
          provider: string
          sport: string | null
          start_time: string
          surface: string | null
          updated_at: string | null
          venue_address: string | null
          venue_lat: number | null
          venue_lng: number | null
          venue_name: string
          venue_postcode: string | null
          venue_slug: string
        }
        Insert: {
          booking_url?: string | null
          court_name: string
          created_at?: string | null
          currency?: string | null
          date: string
          duration?: number
          end_time: string
          id: string
          indoor?: boolean | null
          listing_type?: string | null
          price?: number
          provider?: string
          sport?: string | null
          start_time: string
          surface?: string | null
          updated_at?: string | null
          venue_address?: string | null
          venue_lat?: number | null
          venue_lng?: number | null
          venue_name: string
          venue_postcode?: string | null
          venue_slug: string
        }
        Update: {
          booking_url?: string | null
          court_name?: string
          created_at?: string | null
          currency?: string | null
          date?: string
          duration?: number
          end_time?: string
          id?: string
          indoor?: boolean | null
          listing_type?: string | null
          price?: number
          provider?: string
          sport?: string | null
          start_time?: string
          surface?: string | null
          updated_at?: string | null
          venue_address?: string | null
          venue_lat?: number | null
          venue_lng?: number | null
          venue_name?: string
          venue_postcode?: string | null
          venue_slug?: string
        }
        Relationships: []
      }
      playscanner_page_views: {
        Row: {
          id: string
          page_type: string
          page_url: string | null
          referrer: string | null
          session_id: string | null
          time_on_page: number | null
          viewed_at: string | null
        }
        Insert: {
          id?: string
          page_type: string
          page_url?: string | null
          referrer?: string | null
          session_id?: string | null
          time_on_page?: number | null
          viewed_at?: string | null
        }
        Update: {
          id?: string
          page_type?: string
          page_url?: string | null
          referrer?: string | null
          session_id?: string | null
          time_on_page?: number | null
          viewed_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'playscanner_page_views_session_id_fkey'
            columns: ['session_id']
            isOneToOne: false
            referencedRelation: 'playscanner_sessions'
            referencedColumns: ['session_id']
          },
        ]
      }
      playscanner_rpde_cursors: {
        Row: {
          created_at: string | null
          feed_url: string
          last_polled_at: string | null
          next_url: string
        }
        Insert: {
          created_at?: string | null
          feed_url: string
          last_polled_at?: string | null
          next_url: string
        }
        Update: {
          created_at?: string | null
          feed_url?: string
          last_polled_at?: string | null
          next_url?: string
        }
        Relationships: []
      }
      playscanner_searches: {
        Row: {
          id: string
          results_count: number | null
          search_duration_ms: number | null
          search_params: Json | null
          searched_at: string | null
          session_id: string | null
          viewed_providers: string[] | null
        }
        Insert: {
          id?: string
          results_count?: number | null
          search_duration_ms?: number | null
          search_params?: Json | null
          searched_at?: string | null
          session_id?: string | null
          viewed_providers?: string[] | null
        }
        Update: {
          id?: string
          results_count?: number | null
          search_duration_ms?: number | null
          search_params?: Json | null
          searched_at?: string | null
          session_id?: string | null
          viewed_providers?: string[] | null
        }
        Relationships: [
          {
            foreignKeyName: 'playscanner_searches_session_id_fkey'
            columns: ['session_id']
            isOneToOne: false
            referencedRelation: 'playscanner_sessions'
            referencedColumns: ['session_id']
          },
        ]
      }
      playscanner_sessions: {
        Row: {
          booking_clicks: number | null
          city: string | null
          country_code: string | null
          created_at: string | null
          id: string
          ip_address: unknown
          last_activity: string | null
          page_views: number | null
          search_queries: number | null
          session_duration: number | null
          session_id: string
          started_at: string | null
          user_agent: string | null
          user_id: string | null
        }
        Insert: {
          booking_clicks?: number | null
          city?: string | null
          country_code?: string | null
          created_at?: string | null
          id?: string
          ip_address?: unknown
          last_activity?: string | null
          page_views?: number | null
          search_queries?: number | null
          session_duration?: number | null
          session_id: string
          started_at?: string | null
          user_agent?: string | null
          user_id?: string | null
        }
        Update: {
          booking_clicks?: number | null
          city?: string | null
          country_code?: string | null
          created_at?: string | null
          id?: string
          ip_address?: unknown
          last_activity?: string | null
          page_views?: number | null
          search_queries?: number | null
          session_duration?: number | null
          session_id?: string
          started_at?: string | null
          user_agent?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      playscanner_slots: {
        Row: {
          available: boolean
          booking_url: string | null
          city: string
          collected_at: string
          court_id: string | null
          court_name: string | null
          court_surface: string | null
          created_at: string
          currency: string
          duration: number
          end_time: string
          id: string
          listing_type: string
          price: number
          provider: string
          sport: string
          start_time: string
          updated_at: string
          venue_address: string | null
          venue_id: string
          venue_indoor: boolean
          venue_lat: number | null
          venue_lng: number | null
          venue_name: string
          venue_postcode: string | null
          venue_slug: string | null
          venue_surface: string | null
        }
        Insert: {
          available?: boolean
          booking_url?: string | null
          city: string
          collected_at?: string
          court_id?: string | null
          court_name?: string | null
          court_surface?: string | null
          created_at?: string
          currency?: string
          duration: number
          end_time: string
          id: string
          listing_type?: string
          price: number
          provider: string
          sport: string
          start_time: string
          updated_at?: string
          venue_address?: string | null
          venue_id: string
          venue_indoor?: boolean
          venue_lat?: number | null
          venue_lng?: number | null
          venue_name: string
          venue_postcode?: string | null
          venue_slug?: string | null
          venue_surface?: string | null
        }
        Update: {
          available?: boolean
          booking_url?: string | null
          city?: string
          collected_at?: string
          court_id?: string | null
          court_name?: string | null
          court_surface?: string | null
          created_at?: string
          currency?: string
          duration?: number
          end_time?: string
          id?: string
          listing_type?: string
          price?: number
          provider?: string
          sport?: string
          start_time?: string
          updated_at?: string
          venue_address?: string | null
          venue_id?: string
          venue_indoor?: boolean
          venue_lat?: number | null
          venue_lng?: number | null
          venue_name?: string
          venue_postcode?: string | null
          venue_slug?: string | null
          venue_surface?: string | null
        }
        Relationships: []
      }
      profile_module_privacies: {
        Row: {
          created_at: string
          profile_variant_id: string
          public_to_org_ids: string[]
          updated_at: string
          visibility: Database['public']['Enums']['profile_module_visibility']
        }
        Insert: {
          created_at?: string
          profile_variant_id: string
          public_to_org_ids?: string[]
          updated_at?: string
          visibility?: Database['public']['Enums']['profile_module_visibility']
        }
        Update: {
          created_at?: string
          profile_variant_id?: string
          public_to_org_ids?: string[]
          updated_at?: string
          visibility?: Database['public']['Enums']['profile_module_visibility']
        }
        Relationships: [
          {
            foreignKeyName: 'profile_module_privacies_profile_variant_id_fkey'
            columns: ['profile_variant_id']
            isOneToOne: true
            referencedRelation: 'profile_variants'
            referencedColumns: ['id']
          },
        ]
      }
      profile_variant_sports: {
        Row: {
          achievements: Json | null
          created_at: string | null
          id: string
          is_primary: boolean | null
          profile_variant_id: string | null
          sport_id: string | null
          started_date: string | null
          statistics: Json | null
          updated_at: string | null
        }
        Insert: {
          achievements?: Json | null
          created_at?: string | null
          id?: string
          is_primary?: boolean | null
          profile_variant_id?: string | null
          sport_id?: string | null
          started_date?: string | null
          statistics?: Json | null
          updated_at?: string | null
        }
        Update: {
          achievements?: Json | null
          created_at?: string | null
          id?: string
          is_primary?: boolean | null
          profile_variant_id?: string | null
          sport_id?: string | null
          started_date?: string | null
          statistics?: Json | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'profile_variant_sports_profile_variant_id_fkey'
            columns: ['profile_variant_id']
            isOneToOne: false
            referencedRelation: 'profile_variants'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'profile_variant_sports_sport_id_fkey'
            columns: ['sport_id']
            isOneToOne: false
            referencedRelation: 'sports'
            referencedColumns: ['id']
          },
        ]
      }
      profile_variants: {
        Row: {
          created_at: string | null
          display_name: string | null
          id: string
          is_active: boolean | null
          is_primary: boolean | null
          is_searchable: boolean | null
          is_verified: boolean | null
          module_slug: string
          profile_id: string
          sport_id: string | null
          tags: string[] | null
          updated_at: string | null
          variant_bio: string | null
          variant_type: Database['public']['Enums']['profile_variant_type']
          verification_date: string | null
        }
        Insert: {
          created_at?: string | null
          display_name?: string | null
          id?: string
          is_active?: boolean | null
          is_primary?: boolean | null
          is_searchable?: boolean | null
          is_verified?: boolean | null
          module_slug: string
          profile_id: string
          sport_id?: string | null
          tags?: string[] | null
          updated_at?: string | null
          variant_bio?: string | null
          variant_type: Database['public']['Enums']['profile_variant_type']
          verification_date?: string | null
        }
        Update: {
          created_at?: string | null
          display_name?: string | null
          id?: string
          is_active?: boolean | null
          is_primary?: boolean | null
          is_searchable?: boolean | null
          is_verified?: boolean | null
          module_slug?: string
          profile_id?: string
          sport_id?: string | null
          tags?: string[] | null
          updated_at?: string | null
          variant_bio?: string | null
          variant_type?: Database['public']['Enums']['profile_variant_type']
          verification_date?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'profile_variants_profile_id_fkey'
            columns: ['profile_id']
            isOneToOne: false
            referencedRelation: 'profiles'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'profile_variants_sport_id_fkey'
            columns: ['sport_id']
            isOneToOne: false
            referencedRelation: 'sports'
            referencedColumns: ['id']
          },
        ]
      }
      profile_verifications: {
        Row: {
          created_at: string
          id: string
          profile_id: string
          profile_variant_id: string | null
          revocation_reason: string | null
          revoked_at: string | null
          season_label: string | null
          updated_at: string
          verified_at: string
          verified_by_membership_id: string | null
          verifying_org_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          profile_id: string
          profile_variant_id?: string | null
          revocation_reason?: string | null
          revoked_at?: string | null
          season_label?: string | null
          updated_at?: string
          verified_at?: string
          verified_by_membership_id?: string | null
          verifying_org_id: string
        }
        Update: {
          created_at?: string
          id?: string
          profile_id?: string
          profile_variant_id?: string | null
          revocation_reason?: string | null
          revoked_at?: string | null
          season_label?: string | null
          updated_at?: string
          verified_at?: string
          verified_by_membership_id?: string | null
          verifying_org_id?: string
        }
        Relationships: [
          {
            foreignKeyName: 'profile_verifications_profile_id_fkey'
            columns: ['profile_id']
            isOneToOne: false
            referencedRelation: 'profiles'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'profile_verifications_profile_variant_id_fkey'
            columns: ['profile_variant_id']
            isOneToOne: false
            referencedRelation: 'profile_variants'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'profile_verifications_verified_by_membership_id_fkey'
            columns: ['verified_by_membership_id']
            isOneToOne: false
            referencedRelation: 'organization_members'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'profile_verifications_verifying_org_id_fkey'
            columns: ['verifying_org_id']
            isOneToOne: false
            referencedRelation: 'organizations'
            referencedColumns: ['id']
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          bio: string | null
          cover_image_url: string | null
          created_at: string | null
          date_of_birth: string | null
          email: string | null
          full_name: string | null
          height_cm: number | null
          id: string
          is_admin: boolean
          is_platform_admin: boolean | null
          is_public: boolean | null
          last_dashboard_view_at: string | null
          location: string | null
          nationality: string | null
          phone: string | null
          social_links: Json | null
          updated_at: string | null
          user_id: string
          username: string
          website: string | null
          weight_kg: number | null
        }
        Insert: {
          avatar_url?: string | null
          bio?: string | null
          cover_image_url?: string | null
          created_at?: string | null
          date_of_birth?: string | null
          email?: string | null
          full_name?: string | null
          height_cm?: number | null
          id?: string
          is_admin?: boolean
          is_platform_admin?: boolean | null
          is_public?: boolean | null
          last_dashboard_view_at?: string | null
          location?: string | null
          nationality?: string | null
          phone?: string | null
          social_links?: Json | null
          updated_at?: string | null
          user_id: string
          username: string
          website?: string | null
          weight_kg?: number | null
        }
        Update: {
          avatar_url?: string | null
          bio?: string | null
          cover_image_url?: string | null
          created_at?: string | null
          date_of_birth?: string | null
          email?: string | null
          full_name?: string | null
          height_cm?: number | null
          id?: string
          is_admin?: boolean
          is_platform_admin?: boolean | null
          is_public?: boolean | null
          last_dashboard_view_at?: string | null
          location?: string | null
          nationality?: string | null
          phone?: string | null
          social_links?: Json | null
          updated_at?: string | null
          user_id?: string
          username?: string
          website?: string | null
          weight_kg?: number | null
        }
        Relationships: []
      }
      provider_analytics: {
        Row: {
          avg_booking_value: number | null
          conversion_rate: number | null
          date: string
          estimated_revenue: number | null
          id: string
          provider_name: string
          total_clicks: number | null
          total_impressions: number | null
          updated_at: string | null
        }
        Insert: {
          avg_booking_value?: number | null
          conversion_rate?: number | null
          date: string
          estimated_revenue?: number | null
          id?: string
          provider_name: string
          total_clicks?: number | null
          total_impressions?: number | null
          updated_at?: string | null
        }
        Update: {
          avg_booking_value?: number | null
          conversion_rate?: number | null
          date?: string
          estimated_revenue?: number | null
          id?: string
          provider_name?: string
          total_clicks?: number | null
          total_impressions?: number | null
          updated_at?: string | null
        }
        Relationships: []
      }
      sports: {
        Row: {
          created_at: string | null
          description: string | null
          display_name: string | null
          icon_url: string | null
          id: string
          is_active: boolean | null
          metadata: Json | null
          name: string
          parent_sport_id: string | null
        }
        Insert: {
          created_at?: string | null
          description?: string | null
          display_name?: string | null
          icon_url?: string | null
          id?: string
          is_active?: boolean | null
          metadata?: Json | null
          name: string
          parent_sport_id?: string | null
        }
        Update: {
          created_at?: string | null
          description?: string | null
          display_name?: string | null
          icon_url?: string | null
          id?: string
          is_active?: boolean | null
          metadata?: Json | null
          name?: string
          parent_sport_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'sports_parent_sport_id_fkey'
            columns: ['parent_sport_id']
            isOneToOne: false
            referencedRelation: 'sports'
            referencedColumns: ['id']
          },
        ]
      }
      statistics: {
        Row: {
          competition: string | null
          created_at: string | null
          id: string
          is_verified: boolean | null
          match_id: string | null
          metrics: Json
          opponent: string | null
          profile_variant_id: string
          sport_id: string | null
          stat_date: string
          stat_type: string
          updated_at: string | null
        }
        Insert: {
          competition?: string | null
          created_at?: string | null
          id?: string
          is_verified?: boolean | null
          match_id?: string | null
          metrics?: Json
          opponent?: string | null
          profile_variant_id: string
          sport_id?: string | null
          stat_date: string
          stat_type: string
          updated_at?: string | null
        }
        Update: {
          competition?: string | null
          created_at?: string | null
          id?: string
          is_verified?: boolean | null
          match_id?: string | null
          metrics?: Json
          opponent?: string | null
          profile_variant_id?: string
          sport_id?: string | null
          stat_date?: string
          stat_type?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'statistics_profile_variant_id_fkey'
            columns: ['profile_variant_id']
            isOneToOne: false
            referencedRelation: 'profile_variants'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'statistics_sport_id_fkey'
            columns: ['sport_id']
            isOneToOne: false
            referencedRelation: 'sports'
            referencedColumns: ['id']
          },
        ]
      }
      tiktok_connections: {
        Row: {
          access_token: string
          created_at: string
          expires_at: string
          id: string
          is_active: boolean
          open_id: string
          refresh_expires_at: string | null
          refresh_token: string
          scope: string
          union_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          access_token: string
          created_at?: string
          expires_at: string
          id?: string
          is_active?: boolean
          open_id: string
          refresh_expires_at?: string | null
          refresh_token: string
          scope?: string
          union_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          access_token?: string
          created_at?: string
          expires_at?: string
          id?: string
          is_active?: boolean
          open_id?: string
          refresh_expires_at?: string | null
          refresh_token?: string
          scope?: string
          union_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_preferences: {
        Row: {
          category: Database['public']['Enums']['preference_category']
          created_at: string | null
          id: string
          preferences: Json
          profile_id: string
          updated_at: string | null
        }
        Insert: {
          category: Database['public']['Enums']['preference_category']
          created_at?: string | null
          id?: string
          preferences?: Json
          profile_id: string
          updated_at?: string | null
        }
        Update: {
          category?: Database['public']['Enums']['preference_category']
          created_at?: string | null
          id?: string
          preferences?: Json
          profile_id?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'user_preferences_profile_id_fkey'
            columns: ['profile_id']
            isOneToOne: false
            referencedRelation: 'profiles'
            referencedColumns: ['id']
          },
        ]
      }
    }
    Views: {
      goal_precompute_queue: {
        Row: {
          url: string | null
          veo_highlight_id: string | null
        }
        Relationships: []
      }
      playhub_portrait_render_candidates: {
        Row: {
          club_slug: string | null
          goal_events: number | null
          latest_event_at: string | null
          match_slug: string | null
          renders: number | null
        }
        Relationships: []
      }
      playhub_veo_capture_candidates: {
        Row: {
          capture_attempts: number | null
          capture_id: string | null
          capture_started_at: string | null
          capture_status: string | null
          match_date: string | null
          match_slug: string | null
          title: string | null
          veo_club_slug: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      _handle_new_user_version: { Args: never; Returns: string }
      cleanup_expired_cache: { Args: never; Returns: number }
      current_profile_is_admin: { Args: never; Returns: boolean }
      delete_auth_user: { Args: { user_id: string }; Returns: undefined }
      get_cache_stats: { Args: never; Returns: Json }
      is_org_member: {
        Args: {
          allowed_roles?: Database['public']['Enums']['profile_variant_type'][]
          org_id: string
        }
        Returns: boolean
      }
      playhub_activate_pitch_calibration: {
        Args: {
          p_created_by: string
          p_field_polygon_rayn: Json
          p_frame_height: number
          p_frame_s3_key: string
          p_frame_width: number
          p_homography: Json
          p_marks: Json
          p_mesh_source_game_id: string
          p_pitch_length_m: number
          p_pitch_width_m: number
          p_provider: string
          p_reprojection_error_px: number
          p_scene_id: string
          p_solver_version: number
          p_source: string
          p_venue_organization_id: string
        }
        Returns: {
          created_at: string
          created_by: string | null
          field_polygon_rayn: Json | null
          frame_height: number
          frame_s3_key: string
          frame_width: number
          homography: Json | null
          id: string
          marks: Json
          mesh_source_game_id: string | null
          pitch_length_m: number
          pitch_width_m: number
          provider: string
          reprojection_error_px: number | null
          scene_id: string
          solver_version: number | null
          source: string
          status: string
          superseded_at: string | null
          superseded_by: string | null
          venue_organization_id: string
        }
        SetofOptions: {
          from: '*'
          to: 'playhub_pitch_calibrations'
          isOneToOne: true
          isSetofReturn: false
        }
      }
      playscanner_search_slots_json: {
        Args: {
          p_city: string
          p_date: string
          p_end_time?: string
          p_indoor?: boolean
          p_max_price?: number
          p_sport: string
          p_start_time?: string
        }
        Returns: Json
      }
      playscanner_write_slots: {
        Args: {
          p_attempted_cities: string[]
          p_attempted_sports: string[]
          p_attempted_start_max: string
          p_attempted_start_min: string
          p_provider: string
          p_rows: Json
        }
        Returns: {
          tombstoned: number
          written: number
        }[]
      }
      save_crop_job: {
        Args: {
          p_codec_fingerprint: Json
          p_feedback: Json
          p_job_id: string
          p_keyframes: Json
          p_modal_app_version: string
          p_modal_inference_ms: number
          p_recording_id: string
          p_scene_changes: number[]
          p_status: string
          p_video_url: string
        }
        Returns: Json
      }
    }
    Enums: {
      attribution_revoker: 'player' | 'club' | 'admin'
      attribution_source: 'jersey_map' | 'manual'
      basketball_experience_level:
        | 'recreational'
        | 'amateur_club'
        | 'school_youth'
        | 'university'
        | 'semi_professional'
        | 'professional_domestic'
        | 'professional_elite'
        | 'former_professional'
      clip_type: 'goal' | 'assist' | 'save' | 'tackle' | 'skill' | 'custom'
      football_experience_level:
        | 'recreational'
        | 'school_team'
        | 'sunday_league'
        | 'club_youth'
        | 'academy'
        | 'amateur_club'
        | 'non_league'
        | 'college_university'
        | 'semi_professional'
        | 'professional'
        | 'former_professional'
      preference_category:
        | 'playscanner'
        | 'notifications'
        | 'privacy'
        | 'display'
        | 'communication'
        | 'discovery'
        | 'analytics'
      profile_module_visibility:
        'public' | 'authenticated' | 'club_only' | 'private'
      profile_variant_type:
        | 'player'
        | 'coach'
        | 'scout'
        | 'agent'
        | 'parent'
        | 'fan'
        | 'referee'
        | 'trainer'
        | 'physio'
        | 'club_admin'
        | 'league_admin'
        | 'admin'
        | 'manager'
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, 'public'>]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema['Tables'] & DefaultSchema['Views'])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema['Tables'] &
        DefaultSchema['Views'])
    ? (DefaultSchema['Tables'] &
        DefaultSchema['Views'])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema['Tables'] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema['Tables'] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema['Enums'] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums']
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums'][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema['Enums']
    ? DefaultSchema['Enums'][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema['CompositeTypes']
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes']
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes'][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema['CompositeTypes']
    ? DefaultSchema['CompositeTypes'][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      attribution_revoker: ['player', 'club', 'admin'],
      attribution_source: ['jersey_map', 'manual'],
      basketball_experience_level: [
        'recreational',
        'amateur_club',
        'school_youth',
        'university',
        'semi_professional',
        'professional_domestic',
        'professional_elite',
        'former_professional',
      ],
      clip_type: ['goal', 'assist', 'save', 'tackle', 'skill', 'custom'],
      football_experience_level: [
        'recreational',
        'school_team',
        'sunday_league',
        'club_youth',
        'academy',
        'amateur_club',
        'non_league',
        'college_university',
        'semi_professional',
        'professional',
        'former_professional',
      ],
      preference_category: [
        'playscanner',
        'notifications',
        'privacy',
        'display',
        'communication',
        'discovery',
        'analytics',
      ],
      profile_module_visibility: [
        'public',
        'authenticated',
        'club_only',
        'private',
      ],
      profile_variant_type: [
        'player',
        'coach',
        'scout',
        'agent',
        'parent',
        'fan',
        'referee',
        'trainer',
        'physio',
        'club_admin',
        'league_admin',
        'admin',
        'manager',
      ],
    },
  },
} as const
