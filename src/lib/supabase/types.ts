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
    PostgrestVersion: "12.2.3 (519615d)"
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
          experience_level: Database["public"]["Enums"]["basketball_experience_level"]
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
          experience_level: Database["public"]["Enums"]["basketball_experience_level"]
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
          experience_level?: Database["public"]["Enums"]["basketball_experience_level"]
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
            foreignKeyName: "basketball_player_profiles_profile_variant_id_fkey"
            columns: ["profile_variant_id"]
            isOneToOne: true
            referencedRelation: "profile_variants"
            referencedColumns: ["id"]
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
            foreignKeyName: "career_history_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "career_history_profile_variant_id_fkey"
            columns: ["profile_variant_id"]
            isOneToOne: false
            referencedRelation: "profile_variants"
            referencedColumns: ["id"]
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
            foreignKeyName: "connections_recipient_id_fkey"
            columns: ["recipient_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "connections_requester_id_fkey"
            columns: ["requester_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
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
            foreignKeyName: "education_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      football_player_profiles: {
        Row: {
          created_at: string | null
          experience_level: Database["public"]["Enums"]["football_experience_level"]
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
          experience_level: Database["public"]["Enums"]["football_experience_level"]
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
          experience_level?: Database["public"]["Enums"]["football_experience_level"]
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
            foreignKeyName: "football_player_profiles_profile_variant_id_fkey"
            columns: ["profile_variant_id"]
            isOneToOne: true
            referencedRelation: "profile_variants"
            referencedColumns: ["id"]
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
            foreignKeyName: "highlights_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "highlights_profile_variant_id_fkey"
            columns: ["profile_variant_id"]
            isOneToOne: false
            referencedRelation: "profile_variants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "highlights_sport_id_fkey"
            columns: ["sport_id"]
            isOneToOne: false
            referencedRelation: "sports"
            referencedColumns: ["id"]
          },
        ]
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
          role: Database["public"]["Enums"]["profile_variant_type"]
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
          role: Database["public"]["Enums"]["profile_variant_type"]
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
          role?: Database["public"]["Enums"]["profile_variant_type"]
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "organization_members_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_members_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_members_profile_variant_id_fkey"
            columns: ["profile_variant_id"]
            isOneToOne: false
            referencedRelation: "profile_variants"
            referencedColumns: ["id"]
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
            foreignKeyName: "organizations_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organizations_parent_organization_id_fkey"
            columns: ["parent_organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
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
          has_scholarships: boolean | null
          id: string
          is_active: boolean | null
          logo_url: string | null
          name: string
          organization_id: string | null
          stripe_product_id: string
          updated_at: string | null
          veo_club_slug: string | null
        }
        Insert: {
          additional_stripe_product_ids?: string[] | null
          club_slug: string
          created_at?: string | null
          has_scholarships?: boolean | null
          id?: string
          is_active?: boolean | null
          logo_url?: string | null
          name: string
          organization_id?: string | null
          stripe_product_id: string
          updated_at?: string | null
          veo_club_slug?: string | null
        }
        Update: {
          additional_stripe_product_ids?: string[] | null
          club_slug?: string
          created_at?: string | null
          has_scholarships?: boolean | null
          id?: string
          is_active?: boolean | null
          logo_url?: string | null
          name?: string
          organization_id?: string | null
          stripe_product_id?: string
          updated_at?: string | null
          veo_club_slug?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "playhub_academy_config_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
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
            foreignKeyName: "playhub_access_rights_match_recording_id_fkey"
            columns: ["match_recording_id"]
            isOneToOne: false
            referencedRelation: "playhub_match_recordings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "playhub_access_rights_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "playhub_access_rights_purchase_id_fkey"
            columns: ["purchase_id"]
            isOneToOne: false
            referencedRelation: "playhub_purchases"
            referencedColumns: ["id"]
          },
        ]
      }
      playhub_graphic_packages: {
        Row: {
          created_at: string | null
          id: string
          is_default: boolean | null
          logo_position: string | null
          logo_url: string | null
          name: string
          organization_id: string
          spiideo_graphic_package_id: string | null
          sponsor_logo_url: string | null
          sponsor_position: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          id?: string
          is_default?: boolean | null
          logo_position?: string | null
          logo_url?: string | null
          name: string
          organization_id: string
          spiideo_graphic_package_id?: string | null
          sponsor_logo_url?: string | null
          sponsor_position?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          id?: string
          is_default?: boolean | null
          logo_position?: string | null
          logo_url?: string | null
          name?: string
          organization_id?: string
          spiideo_graphic_package_id?: string | null
          sponsor_logo_url?: string | null
          sponsor_position?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "playhub_graphic_packages_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
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
            foreignKeyName: "playhub_live_streams_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "playhub_live_streams_sport_id_fkey"
            columns: ["sport_id"]
            isOneToOne: false
            referencedRelation: "sports"
            referencedColumns: ["id"]
          },
        ]
      }
      playhub_match_recordings: {
        Row: {
          access_method: string | null
          access_type: string | null
          away_team: string
          billable_amount: number | null
          billable_currency: string | null
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
          pitch_name: string | null
          preview_url: string | null
          price_amount: number | null
          published_at: string | null
          s3_bucket: string | null
          s3_key: string | null
          share_token: string | null
          spiideo_game_id: string | null
          spiideo_production_id: string | null
          sport_id: string | null
          status: string | null
          stripe_payment_intent_id: string | null
          stripe_price_id: string | null
          stripe_product_id: string | null
          sync_attempts: number | null
          thumbnail_url: string | null
          title: string
          transferred_at: string | null
          updated_at: string | null
          venue: string | null
          video_url: string | null
        }
        Insert: {
          access_method?: string | null
          access_type?: string | null
          away_team: string
          billable_amount?: number | null
          billable_currency?: string | null
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
          pitch_name?: string | null
          preview_url?: string | null
          price_amount?: number | null
          published_at?: string | null
          s3_bucket?: string | null
          s3_key?: string | null
          share_token?: string | null
          spiideo_game_id?: string | null
          spiideo_production_id?: string | null
          sport_id?: string | null
          status?: string | null
          stripe_payment_intent_id?: string | null
          stripe_price_id?: string | null
          stripe_product_id?: string | null
          sync_attempts?: number | null
          thumbnail_url?: string | null
          title: string
          transferred_at?: string | null
          updated_at?: string | null
          venue?: string | null
          video_url?: string | null
        }
        Update: {
          access_method?: string | null
          access_type?: string | null
          away_team?: string
          billable_amount?: number | null
          billable_currency?: string | null
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
          pitch_name?: string | null
          preview_url?: string | null
          price_amount?: number | null
          published_at?: string | null
          s3_bucket?: string | null
          s3_key?: string | null
          share_token?: string | null
          spiideo_game_id?: string | null
          spiideo_production_id?: string | null
          sport_id?: string | null
          status?: string | null
          stripe_payment_intent_id?: string | null
          stripe_price_id?: string | null
          stripe_product_id?: string | null
          sync_attempts?: number | null
          thumbnail_url?: string | null
          title?: string
          transferred_at?: string | null
          updated_at?: string | null
          venue?: string | null
          video_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "playhub_match_recordings_graphic_package_id_fkey"
            columns: ["graphic_package_id"]
            isOneToOne: false
            referencedRelation: "playhub_graphic_packages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "playhub_match_recordings_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "playhub_match_recordings_sport_id_fkey"
            columns: ["sport_id"]
            isOneToOne: false
            referencedRelation: "sports"
            referencedColumns: ["id"]
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
            foreignKeyName: "playhub_pending_admin_invites_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
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
            foreignKeyName: "playhub_products_match_recording_id_fkey"
            columns: ["match_recording_id"]
            isOneToOne: false
            referencedRelation: "playhub_match_recordings"
            referencedColumns: ["id"]
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
            foreignKeyName: "playhub_purchases_match_recording_id_fkey"
            columns: ["match_recording_id"]
            isOneToOne: false
            referencedRelation: "playhub_match_recordings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "playhub_purchases_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "playhub_purchases_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "playhub_products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "playhub_purchases_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      playhub_recording_events: {
        Row: {
          confidence_score: number | null
          created_at: string | null
          created_by: string
          event_type: string
          id: string
          label: string | null
          match_recording_id: string
          source: string
          team: string | null
          timestamp_seconds: number
          updated_at: string | null
          visibility: string
        }
        Insert: {
          confidence_score?: number | null
          created_at?: string | null
          created_by: string
          event_type: string
          id?: string
          label?: string | null
          match_recording_id: string
          source?: string
          team?: string | null
          timestamp_seconds: number
          updated_at?: string | null
          visibility?: string
        }
        Update: {
          confidence_score?: number | null
          created_at?: string | null
          created_by?: string
          event_type?: string
          id?: string
          label?: string | null
          match_recording_id?: string
          source?: string
          team?: string | null
          timestamp_seconds?: number
          updated_at?: string | null
          visibility?: string
        }
        Relationships: [
          {
            foreignKeyName: "playhub_recording_events_match_recording_id_fkey"
            columns: ["match_recording_id"]
            isOneToOne: false
            referencedRelation: "playhub_match_recordings"
            referencedColumns: ["id"]
          },
        ]
      }
      playhub_scene_venue_mapping: {
        Row: {
          created_at: string | null
          organization_id: string | null
          scene_id: string
          scene_name: string | null
        }
        Insert: {
          created_at?: string | null
          organization_id?: string | null
          scene_id: string
          scene_name?: string | null
        }
        Update: {
          created_at?: string | null
          organization_id?: string | null
          scene_id?: string
          scene_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "playhub_scene_venue_mapping_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
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
            foreignKeyName: "playhub_stream_access_stream_id_fkey"
            columns: ["stream_id"]
            isOneToOne: false
            referencedRelation: "playhub_live_streams"
            referencedColumns: ["id"]
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
          youtube_rtmp_url: string | null
          youtube_stream_key: string | null
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
          youtube_rtmp_url?: string | null
          youtube_stream_key?: string | null
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
          youtube_rtmp_url?: string | null
          youtube_stream_key?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "playhub_venue_billing_config_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
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
            foreignKeyName: "playhub_venue_invoices_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
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
            foreignKeyName: "playhub_veo_teams_veo_club_slug_fkey"
            columns: ["veo_club_slug"]
            isOneToOne: false
            referencedRelation: "playhub_veo_clubs"
            referencedColumns: ["veo_club_slug"]
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
            foreignKeyName: "playhub_view_history_match_recording_id_fkey"
            columns: ["match_recording_id"]
            isOneToOne: false
            referencedRelation: "playhub_match_recordings"
            referencedColumns: ["id"]
          },
        ]
      }
      playscanner_cache: {
        Row: {
          cache_key: string
          city: string
          created_at: string | null
          date: string
          expires_at: string
          id: string
          metadata: Json | null
          slots: Json
        }
        Insert: {
          cache_key: string
          city: string
          created_at?: string | null
          date: string
          expires_at: string
          id?: string
          metadata?: Json | null
          slots: Json
        }
        Update: {
          cache_key?: string
          city?: string
          created_at?: string | null
          date?: string
          expires_at?: string
          id?: string
          metadata?: Json | null
          slots?: Json
        }
        Relationships: []
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
            foreignKeyName: "playscanner_conversions_search_id_fkey"
            columns: ["search_id"]
            isOneToOne: false
            referencedRelation: "playscanner_searches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "playscanner_conversions_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "playscanner_sessions"
            referencedColumns: ["session_id"]
          },
        ]
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
            foreignKeyName: "playscanner_page_views_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "playscanner_sessions"
            referencedColumns: ["session_id"]
          },
        ]
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
            foreignKeyName: "playscanner_searches_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "playscanner_sessions"
            referencedColumns: ["session_id"]
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
            foreignKeyName: "profile_variant_sports_profile_variant_id_fkey"
            columns: ["profile_variant_id"]
            isOneToOne: false
            referencedRelation: "profile_variants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profile_variant_sports_sport_id_fkey"
            columns: ["sport_id"]
            isOneToOne: false
            referencedRelation: "sports"
            referencedColumns: ["id"]
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
          profile_id: string
          sport_id: string | null
          tags: string[] | null
          updated_at: string | null
          variant_bio: string | null
          variant_type: Database["public"]["Enums"]["profile_variant_type"]
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
          profile_id: string
          sport_id?: string | null
          tags?: string[] | null
          updated_at?: string | null
          variant_bio?: string | null
          variant_type: Database["public"]["Enums"]["profile_variant_type"]
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
          profile_id?: string
          sport_id?: string | null
          tags?: string[] | null
          updated_at?: string | null
          variant_bio?: string | null
          variant_type?: Database["public"]["Enums"]["profile_variant_type"]
          verification_date?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "profile_variants_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profile_variants_sport_id_fkey"
            columns: ["sport_id"]
            isOneToOne: false
            referencedRelation: "sports"
            referencedColumns: ["id"]
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
          is_platform_admin: boolean | null
          is_public: boolean | null
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
          is_platform_admin?: boolean | null
          is_public?: boolean | null
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
          is_platform_admin?: boolean | null
          is_public?: boolean | null
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
            foreignKeyName: "sports_parent_sport_id_fkey"
            columns: ["parent_sport_id"]
            isOneToOne: false
            referencedRelation: "sports"
            referencedColumns: ["id"]
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
            foreignKeyName: "statistics_profile_variant_id_fkey"
            columns: ["profile_variant_id"]
            isOneToOne: false
            referencedRelation: "profile_variants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "statistics_sport_id_fkey"
            columns: ["sport_id"]
            isOneToOne: false
            referencedRelation: "sports"
            referencedColumns: ["id"]
          },
        ]
      }
      user_preferences: {
        Row: {
          category: Database["public"]["Enums"]["preference_category"]
          created_at: string | null
          id: string
          preferences: Json
          profile_id: string
          updated_at: string | null
        }
        Insert: {
          category: Database["public"]["Enums"]["preference_category"]
          created_at?: string | null
          id?: string
          preferences?: Json
          profile_id: string
          updated_at?: string | null
        }
        Update: {
          category?: Database["public"]["Enums"]["preference_category"]
          created_at?: string | null
          id?: string
          preferences?: Json
          profile_id?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "user_preferences_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      cleanup_expired_cache: { Args: never; Returns: number }
      delete_auth_user: { Args: { user_id: string }; Returns: undefined }
      get_cache_stats: { Args: never; Returns: Json }
    }
    Enums: {
      basketball_experience_level:
        | "recreational"
        | "amateur_club"
        | "school_youth"
        | "university"
        | "semi_professional"
        | "professional_domestic"
        | "professional_elite"
        | "former_professional"
      football_experience_level:
        | "recreational"
        | "school_team"
        | "sunday_league"
        | "club_youth"
        | "academy"
        | "amateur_club"
        | "non_league"
        | "college_university"
        | "semi_professional"
        | "professional"
        | "former_professional"
      preference_category:
        | "playscanner"
        | "notifications"
        | "privacy"
        | "display"
        | "communication"
        | "discovery"
        | "analytics"
      profile_variant_type:
        | "player"
        | "coach"
        | "scout"
        | "agent"
        | "parent"
        | "fan"
        | "referee"
        | "trainer"
        | "physio"
        | "club_admin"
        | "league_admin"
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
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      basketball_experience_level: [
        "recreational",
        "amateur_club",
        "school_youth",
        "university",
        "semi_professional",
        "professional_domestic",
        "professional_elite",
        "former_professional",
      ],
      football_experience_level: [
        "recreational",
        "school_team",
        "sunday_league",
        "club_youth",
        "academy",
        "amateur_club",
        "non_league",
        "college_university",
        "semi_professional",
        "professional",
        "former_professional",
      ],
      preference_category: [
        "playscanner",
        "notifications",
        "privacy",
        "display",
        "communication",
        "discovery",
        "analytics",
      ],
      profile_variant_type: [
        "player",
        "coach",
        "scout",
        "agent",
        "parent",
        "fan",
        "referee",
        "trainer",
        "physio",
        "club_admin",
        "league_admin",
      ],
    },
  },
} as const
